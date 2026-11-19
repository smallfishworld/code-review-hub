import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Authentication layer (task 7.1).
 *
 * This phase ships a single admin password. The `Authenticator` interface is
 * the extension point: a future OA/LDAP implementation only needs to supply
 * `verify()` and `describe()`, without touching business routes.
 *
 * The password is stored as `scrypt$<salt-hex>$<hash-hex>` in the `setting`
 * table. Sessions are opaque random tokens held in memory (a restart logs
 * everyone out, which is acceptable for a single-admin intranet tool).
 */

export interface AuthUser {
  username: string;
  displayName: string;
}

export interface Authenticator {
  /** Human-readable auth mode, surfaced by /api/auth/status. */
  describe(): { mode: string; loginRequired: boolean };
  /** Verify credentials; returns the user or null. */
  verify(username: string, password: string): Promise<AuthUser | null>;
}

export const ADMIN_USERNAME = 'admin';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class AdminPasswordAuthenticator implements Authenticator {
  constructor(private readonly db: Database.Database) {}

  describe(): { mode: string; loginRequired: boolean } {
    // An empty stored hash means "no password configured": the console is
    // open (first-run bootstrap state) until an admin sets one.
    return { mode: 'admin-password', loginRequired: this.isConfigured() };
  }

  isConfigured(): boolean {
    const row = this.db
      .prepare("SELECT value FROM setting WHERE key = 'admin_password'")
      .get() as { value: string } | undefined;
    return Boolean(row?.value);
  }

  async verify(username: string, password: string): Promise<AuthUser | null> {
    if (username !== ADMIN_USERNAME) return null;
    const row = this.db
      .prepare("SELECT value FROM setting WHERE key = 'admin_password'")
      .get() as { value: string } | undefined;
    if (!row?.value) return null;
    if (!verifyPasswordHash(password, row.value)) return null;
    return { username: ADMIN_USERNAME, displayName: '管理员' };
  }

  /** Set or replace the admin password (also used for first-run setup). */
  setPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('管理员口令至少 6 位');
    }
    this.db
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('admin_password', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(hashPassword(password));
  }
}

/** In-memory session store with expiry. */
export class SessionStore {
  private sessions = new Map<string, { user: AuthUser; expiresAt: number }>();

  constructor(private readonly ttlMs = 12 * 60 * 60 * 1000) {}

  create(user: AuthUser): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { user, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  get(token: string | undefined): AuthUser | null {
    if (!token) return null;
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return entry.user;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
