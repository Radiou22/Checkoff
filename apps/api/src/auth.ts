import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { User } from '@checkoff/contracts';
import { DomainError, username as usernameSchema, user as userSchema } from '@checkoff/contracts';
import { Database, required, userColumns } from '@checkoff/infra';
import { createParamDecorator, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext, OnModuleInit } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { SharedRedis } from './redis.js';

const derive = promisify<string, Buffer, number, Buffer>(scrypt);
const sessionHours = 8;
type Account = User & { active: boolean; salt: Buffer; hash: Buffer };
type Identity = { sub: string; jti: string };
export type Actor = User & { sessionId: string };
type Request = { headers: { authorization?: string }; actor?: Actor };

export const Public = () => SetMetadata('public', true);
export const Admin = () => SetMetadata('admin', true);
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest<Request>().actor;
  if (!actor) throw new DomainError(401, 'auth_required', 'Authentification requise.');
  return actor;
});

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly redis: SharedRedis,
  ) {}

  async onModuleInit(): Promise<void> {
    const { rowCount } = await this.db.pool.query(
      "SELECT id FROM accounts WHERE role = 'admin' LIMIT 1",
    );
    if (rowCount) return;
    const username = usernameSchema.parse(required('ADMIN_USERNAME'));
    const password = required('ADMIN_PASSWORD', 12);
    if (password.length > 128) throw new Error('ADMIN_PASSWORD dépasse 128 caractères.');
    const salt = randomBytes(16);
    const hash = await derive(password, salt, 64);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(520421)');
      await tx.query(
        `INSERT INTO accounts (username, role, salt, password_hash)
         SELECT $1, 'admin', $2, $3 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'admin')`,
        [username, salt, hash],
      );
    });
  }

  async login(ip: string, input: { username: string; password: string }) {
    const fingerprint = createHash('sha256').update(ip).digest('hex').slice(0, 32);
    const key = `checkoff:login:${Math.floor(Date.now() / 60_000)}:${fingerprint}`;
    const count = await this.redis.client.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 65) end; return n",
      1,
      key,
    );
    if (typeof count !== 'number' || count > 15) {
      throw new DomainError(
        429,
        'login_rate_limited',
        'Trop de tentatives. Réessayez dans une minute.',
      );
    }

    const {
      rows: [account],
    } = await this.db.pool.query<Account>(
      `SELECT ${userColumns}, salt, password_hash AS hash FROM accounts WHERE username = $1`,
      [input.username],
    );
    const hash = await derive(input.password, account?.salt ?? Buffer.alloc(16), 64);
    if (!account?.active || !timingSafeEqual(hash, account.hash)) {
      throw new DomainError(401, 'invalid_credentials', 'Identifiants incorrects.');
    }
    const expires = new Date(Date.now() + sessionHours * 3_600_000);
    const session = await this.db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        'SELECT id FROM accounts WHERE id=$1 AND active FOR SHARE',
        [account.id],
      );
      if (!rowCount) throw new DomainError(401, 'invalid_credentials', 'Identifiants incorrects.');
      await tx.query('DELETE FROM sessions WHERE account_id=$1 AND expires_at <= now()', [
        account.id,
      ]);
      const {
        rows: [session],
      } = await tx.query<Identity>(
        'INSERT INTO sessions (account_id, expires_at) VALUES ($1,$2) RETURNING id AS jti, account_id AS sub',
        [account.id, expires],
      );
      if (!session) throw new Error('Session was not created.');
      return session;
    });
    const token = await this.jwt.signAsync(session, { expiresIn: `${sessionHours}h` });
    return { token, expiresAt: expires.toISOString(), user: userSchema.parse(account) };
  }

  async verify(authorization?: string): Promise<Actor> {
    const token = /^Bearer ([\w.-]+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new DomainError(401, 'auth_required', 'Authentification requise.');
    let identity: Identity;
    try {
      identity = await this.jwt.verifyAsync<Identity>(token);
    } catch {
      throw new DomainError(401, 'invalid_session', 'Session invalide ou expirée.');
    }
    const {
      rows: [account],
    } = await this.db.pool.query<User>(
      `SELECT a.id, a.username, a.role, a.active FROM sessions s JOIN accounts a ON a.id=s.account_id
       WHERE s.id=$1 AND a.id=$2 AND a.active AND s.expires_at > now()`,
      [identity.jti, identity.sub],
    );
    if (!account) throw new DomainError(401, 'invalid_session', 'Session invalide ou expirée.');
    return { ...account, sessionId: identity.jti };
  }

  async logout(actor: Actor): Promise<void> {
    await this.db.pool.query('DELETE FROM sessions WHERE id=$1', [actor.sessionId]);
  }

  async create(input: { username: string; password: string; role: User['role'] }): Promise<User> {
    const salt = randomBytes(16);
    const hash = await derive(input.password, salt, 64);
    const {
      rows: [user],
    } = await this.db.pool.query<User>(
      `INSERT INTO accounts (username, role, salt, password_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING RETURNING ${userColumns}`,
      [input.username, input.role, salt, hash],
    );
    if (!user) throw new DomainError(409, 'user_exists', 'Ce nom d’utilisateur est déjà utilisé.');
    return user;
  }

  async list(after = '') {
    const { rows } = await this.db.pool.query<User>(
      `SELECT ${userColumns} FROM accounts WHERE username > $1 ORDER BY username LIMIT 101`,
      [after],
    );
    return {
      items: rows.slice(0, 100),
      nextAfter: rows[100] ? (rows[99]?.username ?? null) : null,
    };
  }

  async setActive(id: string, active: boolean): Promise<User> {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(520421)');
      const {
        rows: [account],
      } = await tx.query<User>(`SELECT ${userColumns} FROM accounts WHERE id=$1 FOR UPDATE`, [id]);
      if (!account) throw new DomainError(404, 'user_not_found', 'Compte inconnu.');
      if (!active && account.active && account.role === 'admin') {
        const other = await tx.query(
          "SELECT 1 FROM accounts WHERE id <> $1 AND active AND role='admin' LIMIT 1",
          [id],
        );
        if (!other.rowCount)
          throw new DomainError(409, 'last_admin', 'Au moins un administrateur doit rester actif.');
      }
      await tx.query('UPDATE accounts SET active=$2 WHERE id=$1', [id, active]);
      if (!active) await tx.query('DELETE FROM sessions WHERE account_id=$1', [id]);
      return { ...account, active };
    });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('public', targets)) return true;
    const request = ctx.switchToHttp().getRequest<Request>();
    request.actor = await this.auth.verify(request.headers.authorization);
    if (
      this.reflector.getAllAndOverride<boolean>('admin', targets) &&
      request.actor.role !== 'admin'
    ) {
      throw new DomainError(403, 'admin_required', 'Droits administrateur requis.');
    }
    return true;
  }
}
