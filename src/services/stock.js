import { transaction } from '../db.js';
import { appFor, gencod, HttpError, integer, invalid, object, uuid } from '../http.js';

export function stockService(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      gencod TEXT PRIMARY KEY,
      onHand INTEGER NOT NULL CHECK (onHand >= 0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= onHand)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      lines TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released'))
    ) STRICT;
  `);
  const app = appFor('StockManager', config.internalToken);
  const find = db.prepare('SELECT * FROM inventory WHERE gencod = ?');
  const findReservation = db.prepare('SELECT * FROM reservations WHERE id = ?');

  function quantity(row) {
    return { ...row, available: row.onHand - row.reserved };
  }

  app.get('/inventory', (req, res) => {
    const after = req.query.after === undefined ? '' : gencod(req.query.after);
    const rows = db.prepare('SELECT * FROM inventory WHERE gencod > ? ORDER BY gencod LIMIT 101').all(after);
    const items = rows.slice(0, 100).map(quantity);
    res.json({ items, nextAfter: rows.length > 100 ? items.at(-1).gencod : null });
  });

  app.get('/inventory/:gencod', (req, res) => {
    const code = gencod(req.params.gencod);
    res.json(quantity(find.get(code) ?? { gencod: code, onHand: 0, reserved: 0 }));
  });

  app.put('/inventory/:gencod', (req, res) => {
    const code = gencod(req.params.gencod);
    const onHand = integer(object(req.body).onHand, 'onHand');
    const result = db.prepare(`
      INSERT INTO inventory (gencod, onHand) VALUES (?, ?)
      ON CONFLICT(gencod) DO UPDATE SET onHand = excluded.onHand
      WHERE inventory.reserved <= excluded.onHand
    `).run(code, onHand);
    if (!result.changes) {
      throw new HttpError(409, 'stock_reserved', 'La quantité est inférieure au stock réservé.');
    }
    res.json(quantity(find.get(code)));
  });

  app.put('/reservations/:id', (req, res) => {
    const id = uuid(req.params.id);
    const { lines } = object(req.body);
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) invalid('lines');
    const items = lines.map(line => {
      const { gencod: code, quantity: count } = object(line);
      return { gencod: gencod(code), quantity: integer(count, 'quantity', { min: 1, max: 10_000 }) };
    }).sort((left, right) => left.gencod.localeCompare(right.gencod));
    if (new Set(items.map(item => item.gencod)).size !== items.length) invalid('lines');
    const snapshot = JSON.stringify(items);

    const reservation = transaction(db, () => {
      const existing = findReservation.get(id);
      if (existing) {
        if (existing.lines !== snapshot || existing.status === 'released') {
          throw new HttpError(409, 'reservation_conflict', 'Cette réservation existe déjà.');
        }
        return existing;
      }

      const reserve = db.prepare(`
        UPDATE inventory SET reserved = reserved + ? WHERE gencod = ? AND onHand - reserved >= ?
      `);
      for (const { gencod: code, quantity: count } of items) {
        if (!reserve.run(count, code, count).changes) {
          throw new HttpError(409, 'insufficient_stock', `Stock insuffisant pour l’article ${code}.`);
        }
      }
      db.prepare("INSERT INTO reservations VALUES (?, ?, 'reserved')").run(id, snapshot);
      return { id, status: 'reserved' };
    });

    res.json({ id, status: reservation.status });
  });

  function finishReservation(id, status) {
    return transaction(db, () => {
      const reservation = findReservation.get(id);
      if (!reservation) throw new HttpError(404, 'reservation_not_found', 'Réservation inconnue.');
      if (reservation.status === status) return { id, status };
      if (reservation.status !== 'reserved') {
        throw new HttpError(409, 'reservation_conflict', 'La réservation a déjà été traitée.');
      }
      const update = db.prepare('UPDATE inventory SET reserved = reserved - ?, onHand = onHand - ? WHERE gencod = ?');
      for (const { gencod: code, quantity: count } of JSON.parse(reservation.lines)) {
        update.run(count, status === 'committed' ? count : 0, code);
      }
      db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, id);
      return { id, status };
    });
  }

  app.post('/reservations/:id/commit', (req, res) => {
    res.json(finishReservation(uuid(req.params.id), 'committed'));
  });
  app.post('/reservations/:id/release', (req, res) => {
    res.json(finishReservation(uuid(req.params.id), 'released'));
  });

  return app;
}
