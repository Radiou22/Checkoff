import { appFor, HttpError, integer, invalid, object, uuid } from '../http.js';

export function paymentInput(body) {
  const { method, tenderedCents } = object(body);
  if (method !== 'cash' && method !== 'card') invalid('method');
  return { method, tenderedCents: integer(tenderedCents, 'tenderedCents') };
}

export function paymentService(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      checkoutId TEXT NOT NULL,
      method TEXT NOT NULL,
      amountCents INTEGER NOT NULL,
      tenderedCents INTEGER NOT NULL,
      changeCents INTEGER NOT NULL,
      status TEXT NOT NULL,
      processedAt TEXT NOT NULL
    ) STRICT;
  `);
  const app = appFor('PaymentManager', config.internalToken);
  const find = db.prepare('SELECT * FROM payments WHERE id = ?');

  app.put('/payments/:id', (req, res) => {
    const id = uuid(req.params.id);
    const { method, tenderedCents } = paymentInput(req.body);
    const checkoutId = uuid(req.body.checkoutId);
    const amountCents = integer(req.body.amountCents, 'amountCents');
    const existing = find.get(id);
    if (existing) {
      if (existing.checkoutId !== checkoutId || existing.amountCents !== amountCents ||
          existing.method !== method || existing.tenderedCents !== tenderedCents) {
        throw new HttpError(409, 'payment_conflict', 'La tentative de paiement existe déjà.');
      }
      return res.json(existing);
    }

    const accepted = method === 'cash' ? tenderedCents >= amountCents : tenderedCents === amountCents;
    const changeCents = accepted && method === 'cash' ? tenderedCents - amountCents : 0;
    const status = accepted ? 'accepted' : 'declined';
    db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, checkoutId, method, amountCents, tenderedCents, changeCents, status, new Date().toISOString());
    return res.json(find.get(id));
  });

  return app;
}
