import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import {
  article,
  delivery,
  errorEnvelope,
  invoice,
  page,
  sale,
  saleSummary,
  session,
  stock,
  user,
} from '../packages/contracts/dist/index.js';

const base =
  process.env.CHECKOFF_BASE_URL || `https://localhost:${process.env.CHECKOFF_HTTPS_PORT || '8443'}`;
const mail =
  process.env.CHECKOFF_SMOKE_MAIL_URL ||
  `http://127.0.0.1:${process.env.CHECKOFF_MAIL_PORT || '8025'}`;
const secret = process.env.ADMIN_PASSWORD;
assert.ok(secret, 'Définir ADMIN_PASSWORD pour le test de démonstration.');
const instances = new Set<string>();
const auth: { token?: string } = {};

async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  token = auth.token,
): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const instance = response.headers.get('x-checkoff-instance');
  if (instance) instances.add(instance);
  return response;
}

async function data(
  path: string,
  method = 'GET',
  body?: unknown,
  status = 200,
  token?: string,
): Promise<unknown> {
  const response = await call(path, method, body, token);
  const value: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(value)}`);
  return value;
}

const front = await call('/');
assert.equal(front.status, 200);
assert.match(await front.text(), /<title>Checkoff/u);
const docs = await call('/docs/');
assert.equal(docs.status, 200);
assert.match(await docs.text(), /swagger-ui/u);
const spec = await call('/docs/openapi.json');
assert.equal(spec.status, 200);
const openapi = (await spec.json()) as {
  paths: Record<string, { post?: { requestBody?: object; parameters?: unknown[] } }>;
};
const finalizeDocs = openapi.paths['/api/checkouts/{id}/finalize']?.post;
assert.ok(finalizeDocs?.requestBody);
assert.ok(
  finalizeDocs.parameters?.some((param) => JSON.stringify(param).includes('"name":"id"')),
  'Swagger documente le paramètre id.',
);

const anonymous = await data('/api/articles', 'GET', undefined, 401);
assert.equal(errorEnvelope.parse(anonymous).error.code, 'auth_required');
const login = session.parse(
  await data(
    '/api/auth/login',
    'POST',
    {
      username: process.env.ADMIN_USERNAME || 'admin',
      password: secret,
    },
    201,
  ),
);
auth.token = login.token;
assert.equal(login.user.role, 'admin');
const seeded = page(article).parse(await data('/api/articles'));
assert.ok(
  seeded.items.some((item) => item.gencod === '3760123456789'),
  'Le catalogue de démo est prérempli.',
);

const unique = randomUUID().slice(0, 8);
const cashierInput = {
  username: 'test-' + unique,
  password: 'demo-cashier-password',
  role: 'cashier',
};
const cashier = user.parse(await data('/api/users', 'POST', cashierInput, 201));
const cashierToken = session.parse(
  await data(
    '/api/auth/login',
    'POST',
    {
      username: cashierInput.username,
      password: cashierInput.password,
    },
    201,
  ),
).token;
const gencod = String(randomInt(1_000_000, 10_000_000)).padStart(13, '0');
const product = {
  gencod,
  name: 'Article de test',
  brand: 'Checkoff',
  category: 'Démo',
  unitPriceCents: 1199,
  vatRateBps: 2000,
};
assert.equal(
  errorEnvelope.parse(await data('/api/articles', 'POST', product, 403, cashierToken)).error.code,
  'admin_required',
);
await data('/api/articles', 'POST', product, 201);
assert.equal(article.parse(await data('/api/articles/' + gencod)).unitPriceCents, 1199);
await data('/api/articles/' + gencod, 'PATCH', { unitPriceCents: 1200 });
assert.equal(
  article.parse(await data('/api/articles/' + gencod)).unitPriceCents,
  1200,
  'Le cache est invalidé entre réplicas.',
);
await data('/api/stock/' + gencod, 'PUT', { onHand: 1 });

const card = 'TEST-' + unique;
const recipient = unique + '@example.test';
await data('/api/loyalty-cards', 'POST', { code: card, email: recipient }, 201, cashierToken);

async function basket(): Promise<string> {
  const opened = sale.parse(await data('/api/checkouts', 'POST', undefined, 201, cashierToken));
  const path = '/api/checkouts/' + opened.id;
  const filled = sale.parse(
    await data(path + '/lines/' + gencod, 'PUT', { quantity: 1 }, 200, cashierToken),
  );
  assert.equal(filled.totals.vatCents, 200);
  await data(path + '/loyalty-card', 'PUT', { code: card }, 200, cashierToken);
  return path;
}

const first = await basket();
const second = await basket();
const refused = await data(
  first + '/finalize',
  'POST',
  { method: 'cash', tenderedCents: 100 },
  422,
  cashierToken,
);
assert.equal(errorEnvelope.parse(refused).error.code, 'payment_declined');
assert.equal(stock.parse(await data('/api/stock/' + gencod)).onHand, 1);
const payment = { method: 'card', tenderedCents: 1200 };
const results = await Promise.all(
  [first, second].map(async (path) => {
    const result = await call(path + '/finalize', 'POST', payment, cashierToken);
    return { path, status: result.status, body: (await result.json()) as unknown };
  }),
);
const paid = results.find((result) => result.status === 200);
const blocked = results.find((result) => result.status === 409);
assert.ok(paid && blocked, 'Une seule des ventes peut prendre le dernier article.');
assert.equal(errorEnvelope.parse(blocked.body).error.code, 'insufficient_stock');
assert.equal(sale.parse(paid.body).status, 'paid');
assert.deepEqual(
  await data(paid.path + '/finalize', 'POST', payment, 200, cashierToken),
  paid.body,
);
assert.equal(stock.parse(await data('/api/stock/' + gencod)).onHand, 0);
const recentSales = page(saleSummary).parse(
  await data('/api/checkouts', 'GET', undefined, 200, cashierToken),
);
assert.equal(recentSales.items.length, 2);
assert.equal(recentSales.items.find((item) => item.status === 'paid')?.totals.totalCents, 1200);

for (const type of ['ticket', 'invoice']) {
  if (type === 'invoice') {
    const invoiceDetails = { name: 'Client de démonstration', address: '5 rue du Test, Paris' };
    invoice.parse(await data(paid.path + '/invoice', 'PUT', invoiceDetails, 200, cashierToken));
  }
  const pdf = await call(paid.path + '/documents/' + type, 'GET', undefined, cashierToken);
  assert.equal(pdf.status, 200, type);
  assert.match(pdf.headers.get('content-type') || '', /application\/pdf/u);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
}

const url = paid.path + '/documents/ticket/email';
const queued = await Promise.all(
  [0, 1].map(async () => delivery.parse(await data(url, 'POST', undefined, 202, cashierToken))),
);
assert.equal(queued[0]?.id, queued[1]?.id, 'Les deux demandes partagent le même job.');
let deliveryStatus = queued[0];
for (let attempt = 0; attempt < 60 && deliveryStatus?.status === 'pending'; attempt += 1) {
  await wait(350);
  deliveryStatus = delivery.parse(await data(url, 'GET', undefined, 200, cashierToken));
}
assert.equal(
  deliveryStatus?.status,
  'sent',
  deliveryStatus?.lastError || 'Le worker doit livrer le ticket.',
);
assert.ok(deliveryStatus.workerInstance);
const mailbox = await fetch(mail + '/api/v1/messages', { signal: AbortSignal.timeout(5_000) });
assert.equal(mailbox.status, 200);
const listing = (await mailbox.json()) as {
  messages: Array<{ To: Array<{ Address: string }>; Attachments: number }>;
};
const delivered = listing.messages.filter((message) =>
  message.To.some(({ Address }) => Address === recipient),
);
assert.equal(delivered.length, 1, 'Mailpit a capturé exactement un message pour cette vente.');
assert.equal(delivered[0]?.Attachments, 1);

await data('/api/users/' + cashier.id, 'PATCH', { active: false });
assert.equal((await call('/api/auth/me', 'GET', undefined, cashierToken)).status, 401);
assert.ok(
  instances.size >= 2,
  `Au moins deux réplicas API doivent répondre, observés: ${[...instances].join(', ')}`,
);
console.log(
  `Parcours HTTPS validé sur ${instances.size} réplicas API. Tickets et factures PDF, course sur le stock et SMTP Mailpit validés.`,
);
