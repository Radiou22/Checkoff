import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { start } from '../src/index.js';

const credentials = { username: 'admin', password: 'test-password-admin' };
const product = {
  gencod: '0123456789012', name: 'Café', brand: 'Checkoff',
  category: 'Épicerie', unitPriceCents: 1199, vatRateBps: 2000,
};

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'checkoff-test-'));
  const config = {
    service: 'all', dataDir: root, host: '127.0.0.1', port: 0, trustProxy: false,
    internalToken: 'private-integration-test-token-1234',
    adminUsername: credentials.username, adminPassword: credentials.password,
    storeName: 'Magasin de test', mailFrom: 'checkoff@example.test', ...overrides,
  };
  const running = await start(config);
  t.after(async () => {
    await running.close();
    await rm(root, { recursive: true, force: true });
  });
  return { config, running };
}

function client(base) {
  let token = null;
  return {
    async request(path, { method = 'GET', body, status = 200 } = {}) {
      const headers = body === undefined ? {} : { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      const response = await fetch(base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const type = response.headers.get('content-type');
      let data;
      if (type?.includes('application/json')) data = await response.json();
      if (type?.includes('application/pdf')) data = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, status, path + ': ' + JSON.stringify(data?.error));
      return data;
    },
    async login(body = credentials) {
      const session = await this.request('/api/auth/login', { method: 'POST', body, status: 201 });
      token = session.token;
      return session.user;
    },
  };
}

async function catalog(api, stock) {
  await api.request('/api/articles', { method: 'POST', body: product, status: 201 });
  await api.request('/api/stock/' + product.gencod, { method: 'PUT', body: { onHand: stock } });
}

async function basket(api, quantity) {
  const sale = await api.request('/api/checkouts', { method: 'POST', status: 201 });
  const path = '/api/checkouts/' + sale.id;
  const filled = await api.request(path + '/lines/' + product.gencod, {
    method: 'PUT', body: { quantity },
  });
  return { path, sale: filled };
}

test('parcours caisse, stock, facture et envoi avec reprise', async t => {
  const deliveries = [];
  let rejectDelivery = true;
  const { running } = await fixture(t, {
    async sendMail(mail) {
      if (rejectDelivery) throw new Error('SMTP unavailable');
      deliveries.push(mail);
      return { accepted: [mail.to] };
    },
  });
  const admin = client(running.urls.checkout);
  const cashier = client(running.urls.checkout);
  const unauthenticated = await cashier.request('/api/articles', { status: 401 });
  assert.equal(unauthenticated.error.code, 'auth_required');
  const internal = await fetch(running.urls.article + '/articles');
  assert.equal(internal.status, 401);

  const administrator = await admin.login();
  assert.equal(administrator.role, 'admin');
  const account = { username: 'caissier', password: 'test-password-cashier' };
  const created = await admin.request('/api/users', { method: 'POST', body: account, status: 201 });
  assert.equal((await cashier.login(account)).id, created.id);
  await cashier.request('/api/articles', { method: 'POST', body: product, status: 403 });
  await catalog(admin, 5);
  assert.equal((await cashier.request('/api/articles/' + product.gencod)).gencod, product.gencod);

  await cashier.request('/api/loyalty-cards', {
    method: 'POST', body: { code: 'FID-01', email: 'client@example.test' }, status: 201,
  });
  const { path, sale } = await basket(cashier, 2);
  const adminSale = await admin.request('/api/checkouts', { method: 'POST', status: 201 });
  await cashier.request('/api/checkouts/' + adminSale.id, { status: 404 });
  assert.deepEqual((await cashier.request('/api/checkouts')).items.map(item => item.id), [sale.id]);
  assert.deepEqual(sale.totals, {
    currency: 'EUR', itemCount: 2, netCents: 1998, vatCents: 400, totalCents: 2398,
    vatBreakdown: [{ rateBps: 2000, amountCents: 400 }],
  });
  await cashier.request(path + '/loyalty-card', { method: 'PUT', body: { code: 'FID-01' } });
  await cashier.request(path + '/documents/ticket', { status: 409 });
  await admin.request('/api/articles/' + product.gencod, { method: 'PATCH', body: { unitPriceCents: 1499 } });

  const decline = await cashier.request(path + '/finalize', {
    method: 'POST', body: { method: 'cash', tenderedCents: 1000 }, status: 422,
  });
  assert.equal(decline.error.code, 'payment_declined');
  assert.equal((await cashier.request(path)).status, 'open');
  let stock = await cashier.request('/api/stock/' + product.gencod);
  assert.deepEqual(stock, { gencod: product.gencod, onHand: 5, reserved: 0, available: 5 });

  const cash = { method: 'cash', tenderedCents: 2500 };
  const first = await cashier.request(path + '/finalize', { method: 'POST', body: cash });
  const retry = await cashier.request(path + '/finalize', { method: 'POST', body: cash });
  assert.equal(first.status, 'paid');
  assert.equal(first.payment.changeCents, 102);
  assert.deepEqual(first, retry);
  stock = await cashier.request('/api/stock/' + product.gencod);
  assert.deepEqual(stock, { gencod: product.gencod, onHand: 3, reserved: 0, available: 3 });

  const ticket = await cashier.request(path + '/documents/ticket');
  assert.ok(ticket.subarray(0, 5).equals(Buffer.from('%PDF-')));
  const billTo = { name: 'Client Test', address: '8 rue des Tests, Paris' };
  const invoice1 = await cashier.request(path + '/invoice', { method: 'PUT', body: billTo });
  const invoice2 = await cashier.request(path + '/invoice', { method: 'PUT', body: billTo });
  assert.equal(invoice1.number, 1);
  assert.deepEqual(invoice1, invoice2);
  await cashier.request(path + '/invoice', { method: 'PUT', body: { ...billTo, name: 'Autre client' }, status: 409 });
  const invoice = await cashier.request(path + '/documents/invoice');
  assert.ok(invoice.subarray(0, 5).equals(Buffer.from('%PDF-')));

  const send = path + '/documents/ticket/email';
  const failed = await cashier.request(send, { method: 'POST', status: 502 });
  assert.equal(failed.error.code, 'email_failed');
  assert.equal((await cashier.request(path)).status, 'paid');
  rejectDelivery = false;
  const sent = await cashier.request(send, { method: 'POST' });
  assert.deepEqual(await cashier.request(send, { method: 'POST' }), sent);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'client@example.test');
  assert.equal(deliveries[0].attachments[0].contentType, 'application/pdf');

  await admin.request('/api/loyalty-cards/FID-01', { method: 'DELETE', status: 204 });
  await cashier.request('/api/loyalty-cards', {
    method: 'POST', body: { code: 'FID-01', email: 'another@example.test' }, status: 201,
  });
  const missing = await cashier.request(path + '/documents/invoice/email', { method: 'POST', status: 404 });
  assert.equal(missing.error.code, 'loyalty_card_not_found');
  assert.equal(deliveries.length, 1);

  await admin.request('/api/users/' + created.id, { method: 'PATCH', body: { active: false } });
  await cashier.request('/api/auth/me', { status: 401 });
  await admin.request('/api/users/' + administrator.id, { method: 'PATCH', body: { active: false }, status: 409 });
});

test('stock insuffisant pour deux ventes concurrentes', async t => {
  const { running } = await fixture(t);
  const api = client(running.urls.checkout);
  await api.login();
  await catalog(api, 1);
  const first = await basket(api, 1);
  const second = await basket(api, 1);
  const body = { method: 'card', tenderedCents: 1199 };
  const soldFirst = api.request(first.path + '/finalize', { method: 'POST', body });
  const soldSecond = api.request(second.path + '/finalize', { method: 'POST', body });
  const results = await Promise.allSettled([soldFirst, soldSecond]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /insufficient_stock/);
  assert.equal((await api.request('/api/stock/' + product.gencod)).onHand, 0);
});

test('reprise après perte de la réponse du stock et redémarrage de la caisse', async t => {
  const { running, config } = await fixture(t);
  let dropCommitReply = true;
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const token = req.headers['x-checkoff-internal'];
      const response = await fetch(running.urls.stock + req.url, {
        method: req.method,
        headers: { 'x-checkoff-internal': token, 'content-type': 'application/json' },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const data = await response.text();
      if (dropCommitReply && req.url.endsWith('/commit') && response.ok) {
        dropCommitReply = false;
        res.destroy();
        return;
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(data);
    } catch {
      res.destroy();
    }
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const checkoutConfig = {
    ...config, service: 'checkout', dataDir: join(config.dataDir, 'restarted-checkout'),
    serviceUrls: { ...running.urls, stock: 'http://127.0.0.1:' + proxy.address().port },
  };
  let checkout = await start(checkoutConfig);
  t.after(async () => {
    await checkout.close();
    await new Promise(resolve => proxy.close(resolve));
  });

  function checkoutClient() {
    return client('http://127.0.0.1:' + checkout.servers.checkout.address().port);
  }

  let api = checkoutClient();
  await api.login();
  await catalog(api, 2);
  const { path } = await basket(api, 1);
  const body = { method: 'card', tenderedCents: 1199 };
  const failure = await api.request(path + '/finalize', { method: 'POST', body, status: 503 });
  assert.equal(failure.error.code, 'service_unavailable');
  assert.equal((await api.request(path)).status, 'processing');
  assert.equal((await api.request('/api/stock/' + product.gencod)).onHand, 1);

  await checkout.close();
  checkout = await start(checkoutConfig);
  api = checkoutClient();
  await api.login();
  const recovered = await api.request(path + '/finalize', { method: 'POST', body });
  assert.equal(recovered.status, 'paid');
  assert.equal((await api.request('/api/stock/' + product.gencod)).onHand, 1);
});
