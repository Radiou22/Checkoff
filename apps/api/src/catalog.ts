import type { Article } from '@checkoff/contracts';
import { article as articleSchema, DomainError } from '@checkoff/contracts';
import { Database, productColumns } from '@checkoff/infra';
import type { Queryable } from '@checkoff/infra';
import { Injectable } from '@nestjs/common';

import { SharedRedis } from './redis.js';

export async function articleFor(db: Queryable, gencod: string): Promise<Article> {
  const {
    rows: [article],
  } = await db.query<Article>(`SELECT ${productColumns} FROM catalog WHERE gencod=$1`, [gencod]);
  if (!article) throw new DomainError(404, 'article_not_found', 'Article inconnu.');
  return article;
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly redis: SharedRedis,
  ) {}

  async find(gencod: string): Promise<Article> {
    const {
      rows: [row],
    } = await this.db.pool.query<{ revision: string }>('SELECT revision FROM catalog_revision');
    const key = `checkoff:catalog:${row?.revision ?? '0'}:${gencod}`;
    const cached = await this.redis.client.get(key).catch(() => null);
    if (cached) {
      const parsed = articleSchema.safeParse(JSON.parse(cached));
      if (parsed.success) return parsed.data;
    }
    const product = await articleFor(this.db.pool, gencod);
    await this.redis.client.set(key, JSON.stringify(product), 'EX', 300).catch(() => null);
    return product;
  }

  async list(after = '') {
    const { rows } = await this.db.pool.query<Article>(
      `SELECT ${productColumns} FROM catalog WHERE gencod > $1 ORDER BY gencod LIMIT 101`,
      [after],
    );
    return pageOf(rows);
  }

  async create(product: Article): Promise<Article> {
    return this.db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `INSERT INTO catalog VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (gencod) DO NOTHING`,
        [
          product.gencod,
          product.name,
          product.brand,
          product.category,
          product.unitPriceCents,
          product.vatRateBps,
        ],
      );
      if (!rowCount) throw new DomainError(409, 'article_exists', 'Ce GENCOD est déjà utilisé.');
      await tx.query('INSERT INTO inventory (gencod, on_hand) VALUES ($1,0)', [product.gencod]);
      await tx.query('UPDATE catalog_revision SET revision=revision+1');
      return product;
    });
  }

  async update(gencod: string, patch: Partial<Omit<Article, 'gencod'>>): Promise<Article> {
    return this.db.transaction(async (tx) => {
      const {
        rows: [updated],
      } = await tx.query<Article>(
        `UPDATE catalog SET name=coalesce($2,name), brand=coalesce($3,brand), category=coalesce($4,category),
          unit_price_cents=coalesce($5,unit_price_cents), vat_rate_bps=coalesce($6,vat_rate_bps) WHERE gencod=$1
          RETURNING ${productColumns}`,
        [gencod, patch.name, patch.brand, patch.category, patch.unitPriceCents, patch.vatRateBps],
      );
      if (!updated) throw new DomainError(404, 'article_not_found', 'Article inconnu.');
      await tx.query('UPDATE catalog_revision SET revision=revision+1');
      return updated;
    });
  }

  async stock(gencod: string) {
    const {
      rows: [result],
    } = await this.db.pool.query<StockResult>(
      `SELECT ${stockColumns} FROM inventory WHERE gencod=$1`,
      [gencod],
    );
    if (!result) throw new DomainError(404, 'article_not_found', 'Article inconnu.');
    return result;
  }

  async inventory(after = '') {
    const { rows } = await this.db.pool.query<StockResult>(
      `SELECT ${stockColumns} FROM inventory WHERE gencod>$1 ORDER BY gencod LIMIT 101`,
      [after],
    );
    return pageOf(rows);
  }

  async setStock(gencod: string, onHand: number) {
    const {
      rows: [stock],
    } = await this.db.pool.query<StockResult>(
      `UPDATE inventory SET on_hand=$2 WHERE gencod=$1 RETURNING ${stockColumns}`,
      [gencod, onHand],
    );
    if (!stock) throw new DomainError(404, 'article_not_found', 'Article inconnu.');
    return stock;
  }

  async createCard(code: string, email: string) {
    const { rowCount } = await this.db.pool.query(
      'INSERT INTO loyalty_cards (code,email) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',
      [code, email],
    );
    if (!rowCount) throw new DomainError(409, 'loyalty_card_exists', 'Cette carte existe déjà.');
    return { code };
  }

  async updateCard(code: string, email: string) {
    const result = await this.db.pool.query('UPDATE loyalty_cards SET email=$2 WHERE code=$1', [
      code,
      email,
    ]);
    if (!result.rowCount)
      throw new DomainError(404, 'loyalty_card_not_found', 'Carte de fidélité inconnue.');
    return { code };
  }

  async deleteCard(code: string): Promise<void> {
    await this.db.pool.query('DELETE FROM loyalty_cards WHERE code=$1', [code]);
  }
}

type StockResult = { gencod: string; onHand: number; reserved: 0; available: number };
const stockColumns = 'gencod, on_hand AS "onHand", 0 AS reserved, on_hand AS available';

function pageOf<T extends { gencod: string }>(rows: T[]) {
  return { items: rows.slice(0, 100), nextAfter: rows[100] ? (rows[99]?.gencod ?? null) : null };
}
