import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { transaction } from '../db.js';
import { appFor, HttpError, invalid, object, string, uuid } from '../http.js';

const derive = promisify(scrypt);
const sessionLifetime = 8 * 60 * 60 * 1000;

function username(value) {
  const login = string(value, 'username', { min: 3, max: 64 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(login)) invalid('username');
  return login;
}

function password(value, min) {
  if (typeof value !== 'string' || value.length < min || value.length > 128) invalid('password');
  return value;
}

function email(value) {
  const address = string(value, 'email', { max: 254 }).toLowerCase();
  if (!/^[^\s@,<>"()]+@[^\s@,<>"()]+\.[^\s@,<>"()]+$/.test(address)) invalid('email');
  return address;
}

export function loyaltyCode(value) {
  const code = string(value, 'loyaltyCode', { max: 64 });
  if (!/^[a-zA-Z0-9_-]+$/.test(code)) invalid('loyaltyCode');
  return code;
}

function tokenDigest(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new HttpError(401, 'invalid_session', 'Session invalide ou expirée.');
  }
  return createHash('sha256').update(token).digest('hex');
}

export async function usersService(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      salt BLOB NOT NULL,
      passwordHash BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id),
      expiresAt INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS loyalty_cards (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL
    ) STRICT;
  `);
  const app = appFor('UsersManager', config.internalToken);
  const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
  const findCard = db.prepare('SELECT * FROM loyalty_cards WHERE code = ?');

  async function createUser(login, secret, role) {
    const id = randomUUID();
    const salt = randomBytes(16);
    const hash = await derive(secret, salt, 64);
    const result = db.prepare('INSERT OR IGNORE INTO users (id, username, role, salt, passwordHash) VALUES (?, ?, ?, ?, ?)')
      .run(id, login, role, salt, hash);
    if (!result.changes) {
      throw new HttpError(409, 'user_exists', 'Ce nom d’utilisateur est déjà utilisé.');
    }
    return { id, username: login, role, active: true };
  }

  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
    if (!config.adminUsername || !config.adminPassword) {
      throw new Error('Définir ADMIN_USERNAME et ADMIN_PASSWORD pour initialiser UsersManager.');
    }
    await createUser(username(config.adminUsername), password(config.adminPassword, 12), 'admin');
  }

  app.post('/sessions', async (req, res) => {
    const input = object(req.body);
    const account = findUser.get(username(input.username));
    const hash = await derive(password(input.password, 1), account?.salt ?? Buffer.alloc(16), 64);
    if (!account || !timingSafeEqual(hash, account.passwordHash) || !findUser.get(account.username).active) {
      throw new HttpError(401, 'invalid_credentials', 'Identifiants incorrects.');
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionLifetime;
    db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenDigest(token), account.id, expiresAt);
    res.status(201).json({
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: { id: account.id, username: account.username, role: account.role },
    });
  });

  app.post('/sessions/verify', (req, res) => {
    const hash = tokenDigest(object(req.body).token);
    const user = db.prepare(`
      SELECT users.id, users.username, users.role FROM sessions
      JOIN users ON users.id = sessions.userId WHERE tokenHash = ? AND expiresAt > ? AND users.active = 1
    `).get(hash, Date.now());
    if (!user) throw new HttpError(401, 'invalid_session', 'Session invalide ou expirée.');
    res.json(user);
  });

  app.post('/sessions/revoke', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenDigest(object(req.body).token));
    res.json({ revoked: true });
  });

  app.post('/users', async (req, res) => {
    const { username: login, password: secret, role = 'cashier' } = object(req.body);
    if (role !== 'admin' && role !== 'cashier') invalid('role');
    res.status(201).json(await createUser(username(login), password(secret, 12), role));
  });

  app.get('/users', (req, res) => {
    const after = req.query.after === undefined ? '' : username(req.query.after);
    const rows = db.prepare(`
      SELECT id, username, role, active FROM users WHERE username > ? ORDER BY username LIMIT 101
    `).all(after);
    const items = rows.slice(0, 100).map(user => ({ ...user, active: Boolean(user.active) }));
    res.json({ items, nextAfter: rows.length > 100 ? items.at(-1).username : null });
  });

  app.patch('/users/:id', (req, res) => {
    const id = uuid(req.params.id);
    const { active } = object(req.body);
    if (typeof active !== 'boolean') invalid('active');
    const user = transaction(db, () => {
      const account = db.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(id);
      if (!account) throw new HttpError(404, 'user_not_found', 'Compte inconnu.');
      if (!active && account.active && account.role === 'admin') {
        const otherAdmin = db.prepare("SELECT 1 FROM users WHERE id <> ? AND active = 1 AND role = 'admin' LIMIT 1").get(id);
        if (!otherAdmin) throw new HttpError(409, 'last_admin', 'Au moins un administrateur doit rester actif.');
      }
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(Number(active), id);
      if (!active) db.prepare('DELETE FROM sessions WHERE userId = ?').run(id);
      return { ...account, active };
    });
    res.json(user);
  });

  app.post('/loyalty-cards', (req, res) => {
    const input = object(req.body);
    const code = loyaltyCode(input.code);
    const result = db.prepare('INSERT OR IGNORE INTO loyalty_cards VALUES (?, ?, ?)')
      .run(randomUUID(), code, email(input.email));
    if (!result.changes) throw new HttpError(409, 'loyalty_card_exists', 'Cette carte existe déjà.');
    res.status(201).json(findCard.get(code));
  });

  app.get('/loyalty-cards/:code', (req, res) => {
    const card = findCard.get(loyaltyCode(req.params.code));
    if (!card) throw new HttpError(404, 'loyalty_card_not_found', 'Carte de fidélité inconnue.');
    res.json({ id: card.id, code: card.code });
  });

  app.get('/loyalty-recipients/:id', (req, res) => {
    const card = db.prepare('SELECT email FROM loyalty_cards WHERE id = ?').get(uuid(req.params.id));
    if (!card) throw new HttpError(404, 'loyalty_card_not_found', 'Carte de fidélité inconnue.');
    res.json(card);
  });

  app.patch('/loyalty-cards/:code', (req, res) => {
    const code = loyaltyCode(req.params.code);
    const result = db.prepare('UPDATE loyalty_cards SET email = ? WHERE code = ?')
      .run(email(object(req.body).email), code);
    if (!result.changes) throw new HttpError(404, 'loyalty_card_not_found', 'Carte de fidélité inconnue.');
    res.json(findCard.get(code));
  });

  app.delete('/loyalty-cards/:code', (req, res) => {
    db.prepare('DELETE FROM loyalty_cards WHERE code = ?').run(loyaltyCode(req.params.code));
    res.json({ deleted: true });
  });

  return app;
}
