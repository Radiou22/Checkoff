import {
  article,
  delivery,
  errorEnvelope,
  invoice,
  loyaltyResult,
  page,
  sale,
  saleSummary,
  session,
} from '@checkoff/contracts';
import type { Article, BillingDetails, DocumentType, PaymentInput } from '@checkoff/contracts';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function http(token?: string) {
  async function response(path: string, method: string, body?: unknown): Promise<Response> {
    const headers = new Headers();
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const result = await fetch('/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!result.ok) {
      const parsed = errorEnvelope.safeParse(await result.json().catch(() => null));
      throw new ApiError(
        result.status,
        parsed.success ? parsed.data.error.message : 'La requête n’a pas abouti.',
      );
    }
    return result;
  }

  async function json<S extends z.ZodType>(
    schema: S,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<z.output<S>> {
    const result = await response(path, method, body);
    return schema.parse(await result.json());
  }
  return { json, response };
}

export function login(username: string, password: string) {
  return http().json(session, '/auth/login', 'POST', { username, password });
}

export function checkoutApi(token: string) {
  const { json, response } = http(token);
  const checkout = (id: string) => '/checkouts/' + encodeURIComponent(id);
  const document = (id: string, type: DocumentType) => checkout(id) + '/documents/' + type;
  return {
    logout: () => response('/auth/logout', 'POST'),
    getArticle: (code: string) => json(article, '/articles/' + encodeURIComponent(code)),
    articles: async () => {
      const items = [];
      let cursor: string | null = null;
      do {
        const result: { items: Article[]; nextAfter: string | null } = await json(
          page(article),
          '/articles' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''),
        );
        items.push(...result.items);
        cursor = result.nextAfter;
      } while (cursor);
      return items;
    },
    recent: () => json(page(saleSummary), '/checkouts'),
    find: (id: string) => json(sale, checkout(id)),
    create: () => json(sale, '/checkouts', 'POST'),
    line: (id: string, code: string, quantity: number) =>
      json(sale, checkout(id) + '/lines/' + encodeURIComponent(code), 'PUT', { quantity }),
    removeLine: (id: string, code: string) =>
      json(sale, checkout(id) + '/lines/' + encodeURIComponent(code), 'DELETE'),
    createCard: (code: string, email: string) =>
      json(loyaltyResult, '/loyalty-cards', 'POST', { code, email }),
    link: (id: string, code: string | null) =>
      json(sale, checkout(id) + '/loyalty-card', 'PUT', { code }),
    pay: (id: string, body: PaymentInput) => json(sale, checkout(id) + '/finalize', 'POST', body),
    issue: (id: string, body: BillingDetails) =>
      json(invoice, checkout(id) + '/invoice', 'PUT', body),
    pdf: async (id: string, type: DocumentType) =>
      (await response(document(id, type), 'GET')).blob(),
    queue: (id: string, type: DocumentType) =>
      json(delivery, document(id, type) + '/email', 'POST'),
    status: (id: string, type: DocumentType) => json(delivery, document(id, type) + '/email'),
  };
}
