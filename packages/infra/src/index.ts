import type {
  Article,
  Delivery,
  DocumentType,
  Invoice,
  Receipt,
  Sale,
  User,
} from '@checkoff/contracts';
import { calculate, DomainError } from '@checkoff/contracts';
import type { JobsOptions } from 'bullmq';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export type Queryable = Pick<PoolClient, 'query'>;
export type SaleRow = {
  id: string;
  cashierId: string;
  createdAt: Date;
  paidAt: Date | null;
  loyaltyId: string | null;
  loyaltyCode: string | null;
  seller: Receipt['seller'] | null;
};
export type RenderJob = { deliveryId: string; generation: number };
export const queueName = 'receipt-email';
export const queuePrefix = 'checkoff:queue';
export const queueOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
};
export const productColumns =
  'gencod, name, brand, category, unit_price_cents AS "unitPriceCents", vat_rate_bps AS "vatRateBps"';
export const saleColumns = `s.id, s.cashier_id AS "cashierId", s.created_at AS "createdAt", s.paid_at AS "paidAt",
  s.loyalty_id AS "loyaltyId", c.code AS "loyaltyCode", s.seller`;
export const userColumns = 'id, username, role, active';

export function required(key: string, minimumLength = 1): string {
  const value = process.env[key];
  if (!value || value.length < minimumLength)
    throw new Error(`${key} est requis (${minimumLength} caractères minimum).`);
  return value;
}

export function fromEnvInt(key: string, fallback: number): number {
  const value = Number(process.env[key] || fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${key} doit être un entier positif.`);
  return value;
}

export function instanceId(): string {
  return process.env.INSTANCE_ID || process.env.HOSTNAME || 'local';
}

export class Database {
  readonly pool = new Pool({
    connectionString: required('DATABASE_URL'),
    max: fromEnvInt('DB_POOL_SIZE', 8),
    connectionTimeoutMillis: 4_000,
    statement_timeout: 10_000,
  });

  async transaction<T>(run: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await run(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export async function readSale(
  db: Queryable,
  id: string,
  actor?: User,
  lock = false,
): Promise<SaleRow> {
  const scope = actor?.role === 'cashier' ? ' AND s.cashier_id = $2' : '';
  const values = actor?.role === 'cashier' ? [id, actor.id] : [id];
  const {
    rows: [row],
  } = await db.query<SaleRow>(
    `SELECT ${saleColumns} FROM sales s LEFT JOIN loyalty_cards c ON c.id = s.loyalty_id
     WHERE s.id = $1 ${scope} ${lock ? 'FOR UPDATE OF s' : ''}`,
    values,
  );
  if (!row) throw new DomainError(404, 'checkout_not_found', 'Caisse inconnue.');
  return row;
}

export async function readSaleLines(
  db: Queryable,
  saleId: string,
): Promise<Array<Article & { quantity: number }>> {
  return (
    await db.query<Article & { quantity: number }>(
      `SELECT ${productColumns}, quantity FROM sale_lines WHERE sale_id = $1 ORDER BY gencod`,
      [saleId],
    )
  ).rows;
}

type StoredPayment = Omit<NonNullable<Sale['payment']>, 'processedAt'> & { processedAt: Date };
const paymentColumns = `method, amount_cents AS "amountCents", tendered_cents AS "tenderedCents",
     change_cents AS "changeCents", processed_at AS "processedAt"
`;

function presentSale(
  row: SaleRow,
  products: Array<Article & { quantity: number }>,
  transaction?: StoredPayment,
): Sale {
  return {
    ...calculate(products),
    id: row.id,
    cashierId: row.cashierId,
    loyaltyCode: row.loyaltyCode,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    status: row.paidAt ? 'paid' : 'open',
    payment:
      transaction && row.paidAt
        ? { ...transaction, processedAt: transaction.processedAt.toISOString() }
        : null,
  };
}

export async function saleDetails(db: Queryable, row: SaleRow): Promise<Sale> {
  const products = await readSaleLines(db, row.id);
  const payments = row.paidAt
    ? await db.query<StoredPayment>(
        `SELECT ${paymentColumns} FROM payment_attempts WHERE sale_id = $1 AND accepted`,
        [row.id],
      )
    : null;
  return presentSale(row, products, payments?.rows[0]);
}

export async function saleSummaries(db: Queryable, rows: SaleRow[]) {
  if (!rows.length) return [];
  const ids = rows.map(({ id }) => id);
  const products = await db.query<Article & { quantity: number; saleId: string }>(
    `SELECT sale_id AS "saleId", ${productColumns}, quantity
     FROM sale_lines WHERE sale_id=ANY($1::uuid[]) ORDER BY gencod`,
    [ids],
  );
  const payments = await db.query<StoredPayment & { saleId: string }>(
    `SELECT sale_id AS "saleId", ${paymentColumns} FROM payment_attempts
     WHERE sale_id=ANY($1::uuid[]) AND accepted`,
    [ids],
  );
  const bySale = new Map<string, Array<Article & { quantity: number }>>();
  for (const { saleId, ...line } of products.rows) {
    const lines = bySale.get(saleId);
    if (lines) lines.push(line);
    else bySale.set(saleId, [line]);
  }
  const byPayment = new Map(payments.rows.map(({ saleId, ...payment }) => [saleId, payment]));
  return rows.map((row) => {
    const { lines: _lines, ...summary } = presentSale(
      row,
      bySale.get(row.id) ?? [],
      byPayment.get(row.id),
    );
    return summary;
  });
}

export async function readInvoice(db: Queryable, saleId: string): Promise<Invoice | null> {
  const {
    rows: [row],
  } = await db.query<Omit<Invoice, 'issuedAt'> & { issuedAt: Date }>(
    'SELECT sale_id AS "saleId", number, name, address, issued_at AS "issuedAt" FROM invoices WHERE sale_id = $1',
    [saleId],
  );
  return row ? { ...row, issuedAt: row.issuedAt.toISOString() } : null;
}

export async function readReceipt(
  db: Queryable,
  row: SaleRow,
  type: DocumentType,
): Promise<Receipt> {
  if (!row.paidAt || !row.seller)
    throw new DomainError(409, 'checkout_unpaid', 'La vente doit être réglée.');
  const invoice = type === 'invoice' ? await readInvoice(db, row.id) : null;
  if (type === 'invoice' && !invoice)
    throw new DomainError(404, 'invoice_not_found', 'Facture inconnue.');
  return { sale: await saleDetails(db, row), type, seller: row.seller, invoice };
}

export async function renderReceipt(payload: Receipt): Promise<Buffer> {
  try {
    const response = await fetch(new URL('/internal/receipt', required('RECEIPT_URL')), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-checkoff-internal': required('INTERNAL_TOKEN', 32),
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok && response.headers.get('content-type')?.startsWith('application/pdf')) {
      return Buffer.from(await response.arrayBuffer());
    }
  } catch {
    // Expose the same service error for timeouts and dropped connections.
  }
  throw new DomainError(
    503,
    'receipt_unavailable',
    'Le service de justificatifs est momentanément indisponible.',
  );
}

type DeliveryRow = Omit<Delivery, 'sentAt'> & { sentAt: Date | null };
export const deliveryColumns =
  'id, status, attempts, sent_at AS "sentAt", last_error AS "lastError", worker_instance AS "workerInstance"';
export function publicDelivery(row: DeliveryRow): Delivery {
  return { ...row, sentAt: row.sentAt?.toISOString() ?? null };
}

export async function deliveryFor(
  db: Queryable,
  saleId: string,
  type: DocumentType,
): Promise<Delivery> {
  const {
    rows: [row],
  } = await db.query<DeliveryRow>(
    `SELECT ${deliveryColumns} FROM deliveries WHERE sale_id = $1 AND type = $2`,
    [saleId, type],
  );
  if (!row) throw new DomainError(404, 'delivery_not_found', 'Aucun envoi demandé.');
  return publicDelivery(row);
}
