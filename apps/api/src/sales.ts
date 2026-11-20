import type { BillingDetails, DocumentType, PaymentInput, Sale, User } from '@checkoff/contracts';
import { calculate, DomainError } from '@checkoff/contracts';
import {
  Database,
  deliveryFor,
  readInvoice,
  readReceipt,
  readSale,
  readSaleLines,
  renderReceipt,
  saleColumns,
  saleDetails,
  saleSummaries,
} from '@checkoff/infra';
import type { Queryable, SaleRow } from '@checkoff/infra';
import { Injectable } from '@nestjs/common';

import { articleFor } from './catalog.js';

function open(sale: SaleRow): void {
  if (sale.paidAt)
    throw new DomainError(409, 'checkout_locked', 'La caisse n’est plus modifiable.');
}

export function paymentDecision(input: PaymentInput, amount: number) {
  const accepted =
    input.method === 'cash' ? input.tenderedCents >= amount : input.tenderedCents === amount;
  return { accepted, changeCents: accepted ? input.tenderedCents - amount : 0 };
}

async function subtractInventory(
  tx: Queryable,
  lines: Sale['lines'],
  accepted: boolean,
): Promise<void> {
  const codes = lines.map((line) => line.gencod);
  const { rows } = await tx.query<{ gencod: string; onHand: number }>(
    'SELECT gencod, on_hand AS "onHand" FROM inventory WHERE gencod=ANY($1::text[]) ORDER BY gencod FOR UPDATE',
    [codes],
  );
  const stock = new Map(rows.map((row) => [row.gencod, row.onHand]));
  const missing = lines.find((line) => (stock.get(line.gencod) ?? 0) < line.quantity);
  if (missing)
    throw new DomainError(
      409,
      'insufficient_stock',
      `Stock insuffisant pour l’article ${missing.gencod}.`,
    );
  if (accepted) {
    await tx.query(
      `UPDATE inventory i SET on_hand = i.on_hand - line.quantity
       FROM unnest($1::text[], $2::integer[]) AS line(gencod,quantity) WHERE i.gencod = line.gencod`,
      [codes, lines.map((line) => line.quantity)],
    );
  }
}

@Injectable()
export class SalesService {
  constructor(private readonly db: Database) {}

  async create(actor: User): Promise<Sale> {
    return this.db.transaction(async (tx) => {
      const {
        rows: [row],
      } = await tx.query<{ id: string }>(
        'INSERT INTO sales (cashier_id) VALUES ($1) RETURNING id',
        [actor.id],
      );
      if (!row) throw new Error('Sale was not created.');
      return saleDetails(tx, await readSale(tx, row.id, actor));
    });
  }

  async find(id: string, actor: User): Promise<Sale> {
    return this.db.transaction(async (tx) => saleDetails(tx, await readSale(tx, id, actor, true)));
  }

  async list(actor: User, after?: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const cursor = after ? await readSale(tx, after, actor) : null;
      const { rows } = await tx.query<SaleRow>(
        `SELECT ${saleColumns} FROM sales s LEFT JOIN loyalty_cards c ON c.id=s.loyalty_id
         WHERE ($1::uuid IS NULL OR s.cashier_id=$1)
           AND ($2::timestamptz IS NULL OR (s.created_at,s.id)<($2,$3::uuid))
         ORDER BY s.created_at DESC, s.id DESC LIMIT 101`,
        [actor.role === 'admin' ? null : actor.id, cursor?.createdAt ?? null, cursor?.id ?? null],
      );
      const items = await saleSummaries(tx, rows.slice(0, 100));
      return { items, nextAfter: rows[100] ? (items[99]?.id ?? null) : null };
    });
  }

  async setLine(saleId: string, gencod: string, quantity: number, actor: User): Promise<Sale> {
    return this.db.transaction(async (tx) => {
      const row = await readSale(tx, saleId, actor, true);
      open(row);
      const lines = await readSaleLines(tx, row.id);
      const existing = lines.find((line) => line.gencod === gencod);
      if (!existing && lines.length >= 100)
        throw new DomainError(400, 'too_many_lines', 'Maximum de 100 lignes.');
      const product = existing ?? (await articleFor(tx, gencod));
      const { totals } = calculate([
        ...lines.filter((line) => line.gencod !== gencod),
        { ...product, quantity },
      ]);
      if (totals.totalCents > 1_000_000_000)
        throw new DomainError(400, 'checkout_amount', 'Montant du panier trop élevé.');
      await tx.query(
        `INSERT INTO sale_lines (sale_id,gencod,name,brand,category,unit_price_cents,vat_rate_bps,quantity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (sale_id,gencod) DO UPDATE SET quantity=excluded.quantity`,
        [
          saleId,
          gencod,
          product.name,
          product.brand,
          product.category,
          product.unitPriceCents,
          product.vatRateBps,
          quantity,
        ],
      );
      return saleDetails(tx, row);
    });
  }

  async removeLine(id: string, gencod: string, actor: User): Promise<Sale> {
    return this.db.transaction(async (tx) => {
      const row = await readSale(tx, id, actor, true);
      open(row);
      await tx.query('DELETE FROM sale_lines WHERE sale_id=$1 AND gencod=$2', [id, gencod]);
      return saleDetails(tx, row);
    });
  }

  async linkCard(id: string, code: string | null, actor: User): Promise<Sale> {
    return this.db.transaction(async (tx) => {
      const row = await readSale(tx, id, actor, true);
      open(row);
      const card = code
        ? (await tx.query<{ id: string }>('SELECT id FROM loyalty_cards WHERE code=$1', [code]))
            .rows[0]
        : null;
      if (code && !card)
        throw new DomainError(404, 'loyalty_card_not_found', 'Carte de fidélité inconnue.');
      await tx.query('UPDATE sales SET loyalty_id=$2 WHERE id=$1', [id, card?.id ?? null]);
      return saleDetails(tx, { ...row, loyaltyId: card?.id ?? null, loyaltyCode: code });
    });
  }

  async finalize(id: string, input: PaymentInput, actor: User): Promise<Sale> {
    const result = await this.db.transaction(async (tx) => {
      const row = await readSale(tx, id, actor, true);
      const sale = await saleDetails(tx, row);
      if (sale.payment) {
        if (
          sale.payment.method !== input.method ||
          sale.payment.tenderedCents !== input.tenderedCents
        ) {
          throw new DomainError(
            409,
            'payment_attempt_conflict',
            'La vente est déjà payée avec un autre montant ou mode.',
          );
        }
        return sale;
      }
      if (!sale.lines.length) throw new DomainError(409, 'empty_checkout', 'Le panier est vide.');
      const amount = sale.totals.totalCents;
      const decision = paymentDecision(input, amount);
      await subtractInventory(tx, sale.lines, decision.accepted);
      const {
        rows: [attempt],
      } = await tx.query<{ processedAt: Date }>(
        `INSERT INTO payment_attempts (sale_id, method, amount_cents, tendered_cents, change_cents, accepted)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING processed_at AS "processedAt"`,
        [id, input.method, amount, input.tenderedCents, decision.changeCents, decision.accepted],
      );
      if (!attempt) throw new Error('Payment attempt was not registered.');
      if (!decision.accepted) return null;
      const seller = {
        name: process.env.STORE_NAME || 'Checkoff',
        address: process.env.STORE_ADDRESS || '',
        taxId: process.env.STORE_TAX_ID || '',
      };
      await tx.query('UPDATE sales SET paid_at=$2,seller=$3 WHERE id=$1', [
        id,
        attempt.processedAt,
        seller,
      ]);
      return {
        ...sale,
        status: 'paid' as const,
        paidAt: attempt.processedAt.toISOString(),
        payment: {
          ...input,
          changeCents: decision.changeCents,
          amountCents: amount,
          processedAt: attempt.processedAt.toISOString(),
        },
      };
    });
    if (!result)
      throw new DomainError(
        422,
        'payment_declined',
        'Le montant présenté ne permet pas de valider le paiement.',
      );
    return result;
  }

  async issueInvoice(id: string, input: BillingDetails, actor: User) {
    return this.db.transaction(async (tx) => {
      const row = await readSale(tx, id, actor, true);
      if (!row.paidAt) throw new DomainError(409, 'checkout_unpaid', 'La vente doit être réglée.');
      const previous = await readInvoice(tx, id);
      if (previous) {
        if (previous.name !== input.name || previous.address !== input.address) {
          throw new DomainError(409, 'invoice_exists', 'Une facture a déjà été émise.');
        }
        return previous;
      }
      await tx.query('INSERT INTO invoices (sale_id,name,address) VALUES ($1,$2,$3)', [
        id,
        input.name,
        input.address,
      ]);
      const invoice = await readInvoice(tx, id);
      if (!invoice) throw new Error('Invoice was not issued.');
      return invoice;
    });
  }

  async pdf(id: string, type: DocumentType, actor: User): Promise<Buffer> {
    const sale = await readSale(this.db.pool, id, actor);
    const receipt = await readReceipt(this.db.pool, sale, type);
    return renderReceipt(receipt);
  }

  async enqueue(id: string, type: DocumentType, actor: User) {
    return this.db.transaction(async (tx) => {
      const row = await readSale(tx, id, actor, true);
      if (!row.paidAt) throw new DomainError(409, 'checkout_unpaid', 'La vente doit être réglée.');
      if (!row.loyaltyId)
        throw new DomainError(409, 'loyalty_card_required', 'Aucune carte de fidélité associée.');
      if (type === 'invoice' && !(await readInvoice(tx, id))) {
        throw new DomainError(404, 'invoice_not_found', 'Facture inconnue.');
      }
      await tx.query(
        `INSERT INTO deliveries (sale_id,type) VALUES ($1,$2)
         ON CONFLICT (sale_id,type) DO UPDATE SET status='pending', generation=deliveries.generation+1,
           attempts=0, dispatch_after=now(), last_error=null, worker_instance=null
         WHERE deliveries.status='failed'`,
        [id, type],
      );
      return deliveryFor(tx, id, type);
    });
  }

  async delivery(id: string, type: DocumentType, actor: User) {
    await readSale(this.db.pool, id, actor);
    return deliveryFor(this.db.pool, id, type);
  }
}
