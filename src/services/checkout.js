import { randomUUID } from 'node:crypto';
import {
  appFor, gencod, HttpError, integer, invalid, object, serviceClient, uuid,
} from '../http.js';
import { billingDetails } from './receipt.js';
import { paymentInput } from './payment.js';
import { loyaltyCode } from './users.js';

const maxLines = 100;
const maxTotal = 1_000_000_000;

function calculate(lines) {
  const taxByRate = new Map();
  let totalCents = 0;
  let netCents = 0;
  let itemCount = 0;
  const pricedLines = lines.map(line => {
    const gross = line.quantity * line.unitPriceCents;
    const divisor = 10_000 + line.vatRateBps;
    const net = Math.floor((gross * 10_000 + Math.floor(divisor / 2)) / divisor);
    const vat = gross - net;
    const previous = taxByRate.get(line.vatRateBps) ?? 0;
    taxByRate.set(line.vatRateBps, previous + vat);
    totalCents += gross;
    netCents += net;
    itemCount += line.quantity;
    return { ...line, totalCents: gross, netCents: net, vatCents: vat };
  });
  const vatBreakdown = [...taxByRate].sort(([left], [right]) => left - right)
    .map(([rateBps, amountCents]) => ({ rateBps, amountCents }));
  return {
    lines: pricedLines,
    totals: { currency: 'EUR', itemCount, netCents, vatCents: totalCents - netCents, totalCents, vatBreakdown },
  };
}

function present(sale) {
  const { phase, attempt, loyaltyCard, ...details } = sale;
  const status = phase === 'open' || phase === 'paid' ? phase : 'processing';
  const payment = phase === 'paid' ? attempt.payment : undefined;
  return { ...details, ...calculate(sale.lines), status, loyaltyCode: loyaltyCard?.code ?? null, payment };
}

function writable(sale) {
  if (sale.phase !== 'open') throw new HttpError(409, 'checkout_locked', 'La caisse n’est plus modifiable.');
  return sale;
}

function tokenFrom(req) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') ?? '');
  if (!match) throw new HttpError(401, 'auth_required', 'Authentification requise.');
  return match[1];
}

function adminOnly(req, _res, next) {
  if (req.user.role !== 'admin') throw new HttpError(403, 'admin_required', 'Droits administrateur requis.');
  next();
}

function listPath(path, after) {
  return after === undefined ? path : path + '?' + new URLSearchParams({ after: gencod(after) });
}

function checkDocumentType(type) {
  if (type !== 'ticket' && type !== 'invoice') invalid('type');
  return type;
}

export function checkoutService(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY,
      cashierId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      snapshot TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS checkouts_created ON checkouts (createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS checkouts_cashier ON checkouts (cashierId, createdAt DESC, id DESC);
  `);
  const app = appFor('CheckoutManager');
  app.set('trust proxy', config.trustProxy);
  const { article, stock, payment, receipt, users } = Object.fromEntries(
    Object.entries(config.serviceUrls).map(([name, url]) => [name, serviceClient(url, config.internalToken)])
  );
  const find = db.prepare('SELECT snapshot FROM checkouts WHERE id = ?');
  const store = db.prepare(`
    INSERT INTO checkouts VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot
  `);
  const processing = new Set();

  function save(sale) {
    store.run(sale.id, sale.cashierId, sale.createdAt, JSON.stringify(sale));
  }

  function saleFor(req, id = req.params.id) {
    const record = find.get(uuid(id));
    const sale = record && JSON.parse(record.snapshot);
    if (!sale || (sale.cashierId !== req.user.id && req.user.role !== 'admin')) {
      throw new HttpError(404, 'checkout_not_found', 'Caisse inconnue.');
    }
    return sale;
  }

  const loginAttempts = new Map();
  let loginWindow = 0;
  if (config.corsOrigin) {
    app.use('/api', (req, res, next) => {
      res.vary('Origin');
      if (req.get('origin') === config.corsOrigin) {
        res.set({
          'Access-Control-Allow-Origin': config.corsOrigin,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
      }
      return next();
    });
  }

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.post('/api/auth/login', async (req, res) => {
    const window = Math.floor(Date.now() / 60_000);
    if (window !== loginWindow) {
      loginWindow = window;
      loginAttempts.clear();
    }
    const attempts = loginAttempts.get(req.ip) ?? 0;
    if (attempts >= 15 || (attempts === 0 && loginAttempts.size >= 1000)) {
      res.set('Retry-After', '60');
      throw new HttpError(429, 'login_rate_limited', 'Trop de tentatives de connexion.');
    }
    loginAttempts.set(req.ip, attempts + 1);
    res.status(201).json(await users('/sessions', { method: 'POST', body: object(req.body) }));
  });

  app.use('/api', async (req, _res, next) => {
    req.sessionToken = tokenFrom(req);
    req.user = await users('/sessions/verify', { method: 'POST', body: { token: req.sessionToken } });
    next();
  });

  app.get('/api/auth/me', (req, res) => res.json(req.user));
  app.post('/api/auth/logout', async (req, res) => {
    await users('/sessions/revoke', { method: 'POST', body: { token: req.sessionToken } });
    res.sendStatus(204);
  });
  app.post('/api/users', adminOnly, async (req, res) => {
    res.status(201).json(await users('/users', { method: 'POST', body: object(req.body) }));
  });
  app.get('/api/users', adminOnly, async (req, res) => {
    const { after } = req.query;
    if (after !== undefined && typeof after !== 'string') invalid('after');
    const query = after === undefined ? '' : '?' + new URLSearchParams({ after });
    res.json(await users('/users' + query));
  });
  app.patch('/api/users/:id', adminOnly, async (req, res) => {
    res.json(await users('/users/' + uuid(req.params.id), { method: 'PATCH', body: object(req.body) }));
  });

  app.get('/api/articles', async (req, res) => res.json(await article(listPath('/articles', req.query.after))));
  app.get('/api/articles/:gencod', async (req, res) => {
    res.json(await article('/articles/' + gencod(req.params.gencod)));
  });
  app.post('/api/articles', adminOnly, async (req, res) => {
    res.status(201).json(await article('/articles', { method: 'POST', body: object(req.body) }));
  });
  app.patch('/api/articles/:gencod', adminOnly, async (req, res) => {
    res.json(await article('/articles/' + gencod(req.params.gencod), { method: 'PATCH', body: object(req.body) }));
  });

  app.get('/api/stock', async (req, res) => res.json(await stock(listPath('/inventory', req.query.after))));
  app.get('/api/stock/:gencod', async (req, res) => {
    const code = gencod(req.params.gencod);
    await article('/articles/' + code);
    res.json(await stock('/inventory/' + code));
  });
  app.put('/api/stock/:gencod', adminOnly, async (req, res) => {
    const code = gencod(req.params.gencod);
    await article('/articles/' + code);
    res.json(await stock('/inventory/' + code, { method: 'PUT', body: object(req.body) }));
  });

  app.post('/api/loyalty-cards', async (req, res) => {
    const { code } = await users('/loyalty-cards', { method: 'POST', body: object(req.body) });
    res.status(201).json({ code });
  });
  app.patch('/api/loyalty-cards/:code', adminOnly, async (req, res) => {
    const code = loyaltyCode(req.params.code);
    await users('/loyalty-cards/' + code, { method: 'PATCH', body: object(req.body) });
    res.json({ code });
  });
  app.delete('/api/loyalty-cards/:code', adminOnly, async (req, res) => {
    await users('/loyalty-cards/' + loyaltyCode(req.params.code), { method: 'DELETE' });
    res.sendStatus(204);
  });

  app.post('/api/checkouts', (req, res) => {
    const sale = {
      id: randomUUID(), cashierId: req.user.id, createdAt: new Date().toISOString(),
      phase: 'open', lines: [], loyaltyCard: null,
    };
    save(sale);
    res.status(201).json(present(sale));
  });

  app.get('/api/checkouts', (req, res) => {
    const anchor = req.query.after === undefined ? null : saleFor(req, req.query.after);
    const filters = [];
    const values = [];
    if (req.user.role !== 'admin') {
      filters.push('cashierId = ?');
      values.push(req.user.id);
    }
    if (anchor) {
      filters.push('(createdAt, id) < (?, ?)');
      values.push(anchor.createdAt, anchor.id);
    }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT snapshot FROM checkouts ${where} ORDER BY createdAt DESC, id DESC LIMIT 101
    `).all(...values);
    const items = rows.slice(0, 100).map(row => {
      const { lines, ...summary } = present(JSON.parse(row.snapshot));
      return summary;
    });
    res.json({ items, nextAfter: rows.length > 100 ? items.at(-1).id : null });
  });

  app.get('/api/checkouts/:id', (req, res) => res.json(present(saleFor(req))));
  app.put('/api/checkouts/:id/lines/:gencod', async (req, res) => {
    const code = gencod(req.params.gencod);
    const quantity = integer(object(req.body).quantity, 'quantity', { min: 1, max: 10_000 });
    const initial = writable(saleFor(req));
    const product = initial.lines.find(line => line.gencod === code) ?? await article('/articles/' + code);
    const sale = writable(saleFor(req));
    const existing = sale.lines.findIndex(line => line.gencod === code);
    if (existing < 0 && sale.lines.length >= maxLines) invalid('le nombre de lignes');
    const line = { ...(sale.lines[existing] ?? product), quantity };
    if (existing >= 0) sale.lines[existing] = line;
    else sale.lines.push(line);
    const response = present(sale);
    if (response.totals.totalCents > maxTotal) invalid('le montant du panier');
    save(sale);
    res.json(response);
  });

  app.delete('/api/checkouts/:id/lines/:gencod', (req, res) => {
    const code = gencod(req.params.gencod);
    const sale = writable(saleFor(req));
    sale.lines = sale.lines.filter(line => line.gencod !== code);
    save(sale);
    res.json(present(sale));
  });

  app.put('/api/checkouts/:id/loyalty-card', async (req, res) => {
    const input = object(req.body);
    const code = input.code === null ? null : loyaltyCode(input.code);
    writable(saleFor(req));
    const card = code ? await users('/loyalty-cards/' + code) : null;
    const sale = writable(saleFor(req));
    sale.loyaltyCard = card;
    save(sale);
    res.json(present(sale));
  });

  function transition(sale, phase) {
    sale.phase = phase;
    if (phase === 'open') delete sale.attempt;
    save(sale);
  }

  async function finalize(sale, input) {
    if (sale.attempt && (input.method !== sale.attempt.method || input.tenderedCents !== sale.attempt.tenderedCents)) {
      throw new HttpError(409, 'payment_attempt_conflict', 'La tentative doit être reprise avec les mêmes données.');
    }
    if (sale.phase === 'paid') return present(sale);
    if (!sale.lines.length) throw new HttpError(409, 'empty_checkout', 'Le panier est vide.');
    if (sale.phase === 'open') {
      sale.attempt = { id: randomUUID(), ...input };
      transition(sale, 'reserving');
    }

    const path = '/reservations/' + sale.attempt.id;
    if (sale.phase === 'reserving') {
      const lines = sale.lines.map(({ gencod: code, quantity }) => ({ gencod: code, quantity }));
      try {
        await stock(path, { method: 'PUT', body: { lines } });
      } catch (error) {
        if (error.code === 'insufficient_stock') transition(sale, 'open');
        throw error;
      }
      transition(sale, 'paying');
    }

    if (sale.phase === 'paying') {
      const body = { checkoutId: sale.id, amountCents: calculate(sale.lines).totals.totalCents, ...input };
      sale.attempt.payment = await payment('/payments/' + sale.attempt.id, { method: 'PUT', body });
      transition(sale, sale.attempt.payment.status === 'accepted' ? 'committing' : 'releasing');
    }

    if (sale.phase === 'releasing') {
      await stock(path + '/release', { method: 'POST' });
      transition(sale, 'open');
      throw new HttpError(422, 'payment_declined', 'Le montant présenté ne permet pas de valider le paiement.');
    }

    await stock(path + '/commit', { method: 'POST' });
    sale.paidAt = sale.attempt.payment.processedAt;
    transition(sale, 'paid');
    return present(sale);
  }

  app.post('/api/checkouts/:id/finalize', async (req, res) => {
    const input = paymentInput(req.body);
    const sale = saleFor(req);
    if (processing.has(sale.id)) throw new HttpError(409, 'checkout_processing', 'La vente est en cours de traitement.');

    processing.add(sale.id);
    try {
      res.json(await finalize(sale, input));
    } finally {
      processing.delete(sale.id);
    }
  });

  async function receiptPath(sale) {
    if (sale.phase !== 'paid') throw new HttpError(409, 'checkout_unpaid', 'La vente doit être réglée.');
    const path = '/receipts/' + sale.id;
    const snapshot = present(sale);
    const { id, status, paidAt, lines, totals, payment: paymentDetails } = snapshot;
    const body = { id, status, paidAt, lines, totals, payment: { method: paymentDetails.method, changeCents: paymentDetails.changeCents } };
    await receipt(path, { method: 'PUT', body });
    return path;
  }

  app.put('/api/checkouts/:id/invoice', async (req, res) => {
    const details = billingDetails(req.body);
    const path = await receiptPath(saleFor(req));
    res.json(await receipt(path + '/invoice', { method: 'PUT', body: details }));
  });

  app.get('/api/checkouts/:id/documents/:type', async (req, res) => {
    const type = checkDocumentType(req.params.type);
    const sale = saleFor(req);
    const path = await receiptPath(sale);
    const pdf = await receipt(path + '/pdf/' + type);
    res.type('pdf').attachment(`${type}-${sale.id}.pdf`).send(pdf);
  });

  app.post('/api/checkouts/:id/documents/:type/email', async (req, res) => {
    const type = checkDocumentType(req.params.type);
    const sale = saleFor(req);
    const path = await receiptPath(sale);
    if (!sale.loyaltyCard) throw new HttpError(409, 'loyalty_card_required', 'Aucune carte de fidélité associée.');
    const { email } = await users('/loyalty-recipients/' + sale.loyaltyCard.id);
    res.json(await receipt(path + '/email/' + type, { method: 'POST', body: { email } }));
  });

  return app;
}
