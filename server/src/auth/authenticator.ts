import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ALL_PERMISSIONS, parsePermissionsJson, type Permission } from './permissions.js';

/**
 * Multi-user RBAC authentication & persistent SQLite session store.
 *
 * Passwords are stored as `scrypt$<salt-hex>$<hash-hex>`.
 * Sessions are stored in `auth_session` keyed by `sha256(token)` so the raw
 * bearer/cookie token is never persisted in plaintext, survives restarts, and
 * can be revoked immediately when a user is disabled or has their password reset.
 */

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  roleId: number | null;
  roleName: string | null;
  isSuperAdmin: boolean;
  permissions: Permission[];
  mustChangePassword: boolean;
  status: 'active' | 'disabled';
}

export const ADMIN_USERNAME = 'admin';
const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code?: string
  ) {
    super(message);
  }
}

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

export function validateNewPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new AuthError('密码长度至少 8 位', 400);
  }
  if (password.length > 128) {
    throw new AuthError('密码长度不能超过 128 位', 400);
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new AuthError('密码必须同时包含字母和数字', 400);
  }
}

export function validateUsername(username: string): string {
  const trimmed = (username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(trimmed)) {
    throw new AuthError('用户名需为 3–32 位字母、数字、点、下划线或连字符', 400);
  }
  return trimmed;
}

export function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

interface JoinedUserRow {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  role_id: number | null;
  role_name: string | null;
  role_permissions: string | null;
  is_super_admin: number;
  status: 'active' | 'disabled';
  must_change_password: number;
  failed_logins: number;
  locked_until: string | null;
}

function rowToAuthUser(row: JoinedUserRow): AuthUser {
  const isSuperAdmin = row.is_super_admin === 1;
  const permissions: Permission[] = isSuperAdmin
    ? ALL_PERMISSIONS.map((p) => p.id)
    : parsePermissionsJson(row.role_permissions);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    roleId: row.role_id,
    roleName: row.role_name,
    isSuperAdmin,
    permissions,
    mustChangePassword: row.must_change_password === 1,
    status: row.status,
  };
}

export function hasPermission(user: AuthUser | null, perm: Permission): boolean {
  if (!user || user.status !== 'active') return false;
  if (user.isSuperAdmin) return true;
  return user.permissions.includes(perm);
}

/** Persistent SQLite session store; always resolves live user & role permissions. */
export class SessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly ttlMs = 12 * 60 * 60 * 1000
  ) {}

  create(userId: number, meta?: { ip?: string; userAgent?: string }): string {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO auth_session (token_hash, user_id, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(tokenHash, userId, expiresAt, meta?.ip ?? null, meta?.userAgent?.slice(0, 300) ?? null);
    return token;
  }

  get(token: string | undefined): AuthUser | null {
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const row = this.db
      .prepare(
        `SELECT s.expires_at,
                u.id, u.username, u.display_name, u.email, u.password_hash,
                u.role_id, u.is_super_admin, u.status, u.must_change_password,
                u.failed_logins, u.locked_until,
                r.name AS role_name, r.permissions AS role_permissions
         FROM auth_session s
         JOIN user u ON u.id = s.user_id
         LEFT JOIN role r ON r.id = u.role_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as (JoinedUserRow & { expires_at: string }) | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now() || row.status !== 'active') {
      this.db.prepare('DELETE FROM auth_session WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return rowToAuthUser(row);
  }

  destroy(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM auth_session WHERE token_hash = ?').run(sha256Hex(token));
  }

  destroyAllForUser(userId: number): void {
    this.db.prepare('DELETE FROM auth_session WHERE user_id = ?').run(userId);
  }

  destroyOtherForUser(userId: number, keepToken: string | undefined): void {
    if (!keepToken) {
      this.destroyAllForUser(userId);
      return;
    }
    this.db
      .prepare('DELETE FROM auth_session WHERE user_id = ? AND token_hash != ?')
      .run(userId, sha256Hex(keepToken));
  }

  pruneExpired(): void {
    this.db
      .prepare("DELETE FROM auth_session WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .run();
  }
}

export class AuditLogger {
  constructor(private readonly db: Database.Database) {}

  log(entry: {
    userId?: number | null;
    username: string;
    action: string;
    target?: string | null;
    detail?: string | null;
    ip?: string | null;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO audit_log (user_id, username, action, target, detail, ip)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.userId ?? null,
          entry.username,
          entry.action,
          entry.target ?? null,
          entry.detail ?? null,
          entry.ip ?? null
        );
    } catch {
      // Audit failures must never break business operations.
    }
  }

  list(limit = 100): {
    id: number;
    userId: number | null;
    username: string;
    action: string;
    target: string | null;
    detail: string | null;
    ip: string | null;
    createdAt: string;
  }[] {
    const parsed = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const safeLimit = Math.min(Math.max(parsed, 1), 500);
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      userId: (r.user_id as number | null) ?? null,
      username: r.username as string,
      action: r.action as string,
      target: (r.target as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  }
}

export const INITIAL_ADMIN_PASSWORD_FILE = 'initial-admin-password.txt';

export interface InitialAdminCredentials {
  username: string;
  password: string;
  filePath: string | null;
}

function generateInitialPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = randomBytes(12);
  const chars = [
    letters[bytes[0] % letters.length],
    digits[bytes[1] % digits.length],
    ...Array.from(bytes.subarray(2), (b) => all[b % all.length]),
  ];
  return chars.join('');
}

export class AuthService {
  private readonly dataDir: string | null;
  readonly initialAdmin: InitialAdminCredentials | null;

  constructor(
    private readonly db: Database.Database,
    private readonly sessions: SessionStore,
    private readonly audit: AuditLogger,
    options: { dataDir?: string; initialAdminPassword?: string; autoBootstrap?: boolean } = {}
  ) {
    this.dataDir = options.dataDir ?? null;
    this.initialAdmin =
      options.autoBootstrap === false
        ? null
        : this.ensureInitialAdmin(options.initialAdminPassword);
  }

  isInitialized(): boolean {
    const row = this.db.prepare('SELECT 1 FROM user LIMIT 1').get();
    return Boolean(row);
  }

  /**
   * First-run bootstrap: automatically create `admin` with a random initial
   * password (must be changed on first login) and write it to
   * `<dataDir>/initial-admin-password.txt` (deleted once password is changed).
   */
  private ensureInitialAdmin(explicitPassword?: string): InitialAdminCredentials | null {
    if (this.isInitialized()) return null;
    const password = explicitPassword?.trim() || generateInitialPassword();
    validateNewPassword(password);
    const hash = hashPassword(password);

    const tx = this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM user LIMIT 1').get()) return null;
      const superRole = this.db
        .prepare("SELECT id FROM role WHERE name = '超级管理员' LIMIT 1")
        .get() as { id: number } | undefined;
      const info = this.db
        .prepare(
          `INSERT INTO user
             (username, display_name, password_hash, role_id, is_super_admin, status, must_change_password)
           VALUES (?, '超级管理员', ?, ?, 1, 'active', 1)`
        )
        .run(ADMIN_USERNAME, hash, superRole?.id ?? null);
      return Number(info.lastInsertRowid);
    });

    const userId = tx.immediate();
    if (userId === null) return null;

    let filePath: string | null = null;
    if (this.dataDir) {
      try {
        mkdirSync(this.dataDir, { recursive: true });
        filePath = join(this.dataDir, INITIAL_ADMIN_PASSWORD_FILE);
        writeFileSync(
          filePath,
          [
            'Code Review Hub 首次启动初始超级管理员账号',
            `用户名：${ADMIN_USERNAME}`,
            `初始密码：${password}`,
            '（请登录后尽快修改密码，修改完成后本文件将自动删除）',
            '',
          ].join('\n'),
          { encoding: 'utf8', mode: 0o600 }
        );
      } catch {
        filePath = null;
      }
    }

    this.audit.log({
      userId,
      username: ADMIN_USERNAME,
      action: 'system.init_admin',
      target: ADMIN_USERNAME,
      detail: '首次启动自动创建初始超级管理员账号',
    });

    return { username: ADMIN_USERNAME, password, filePath };
  }

  getUserById(id: number): AuthUser | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.email, u.password_hash,
                u.role_id, u.is_super_admin, u.status, u.must_change_password,
                u.failed_logins, u.locked_until,
                r.name AS role_name, r.permissions AS role_permissions
         FROM user u
         LEFT JOIN role r ON r.id = u.role_id
         WHERE u.id = ?`
      )
      .get(id) as JoinedUserRow | undefined;
    return row ? rowToAuthUser(row) : null;
  }

  /** Verify credentials with brute-force lockout and registration-status hint after password check. */
  login(usernameInput: string, password: string, ip?: string): AuthUser {
    const username = (usernameInput ?? '').trim();
    if (!username || !password) {
      throw new AuthError('请输入用户名和密码', 400);
    }
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.email, u.password_hash,
                u.role_id, u.is_super_admin, u.status, u.must_change_password,
                u.failed_logins, u.locked_until,
                r.name AS role_name, r.permissions AS role_permissions
         FROM user u
         LEFT JOIN role r ON r.id = u.role_id
         WHERE u.username = ?`
      )
      .get(username) as JoinedUserRow | undefined;

    if (!row) {
      // Check if there is a matching registration request (only reveal status if password matches).
      const reqRow = this.db
        .prepare(
          `SELECT status, password_hash, reject_reason
           FROM registration_request
           WHERE username = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(username) as
        | { status: 'pending' | 'approved' | 'rejected'; password_hash: string; reject_reason: string | null }
        | undefined;
      if (reqRow && verifyPasswordHash(password, reqRow.password_hash)) {
        if (reqRow.status === 'pending') {
          throw new AuthError('您的注册申请正在审核中，请等待管理员审批', 403, 'REGISTRATION_PENDING');
        }
        if (reqRow.status === 'rejected') {
          const reason = reqRow.reject_reason ? `：${reqRow.reject_reason}` : '';
          throw new AuthError(`您的注册申请已被拒绝${reason}`, 403, 'REGISTRATION_REJECTED');
        }
      }
      this.audit.log({ username, action: 'auth.login_failed', detail: '用户名或密码错误', ip });
      throw new AuthError('用户名或密码错误', 401);
    }

    if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
      const remainMin = Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 60_000));
      throw new AuthError(`登录失败次数过多，账号已锁定，请 ${remainMin} 分钟后再试`, 429);
    }

    if (!verifyPasswordHash(password, row.password_hash)) {
      const nextFails = row.failed_logins + 1;
      const lockedUntil =
        nextFails >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_DURATION_MS).toISOString() : null;
      this.db
        .prepare('UPDATE user SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .run(nextFails, lockedUntil, row.id);
      this.audit.log({
        userId: row.id,
        username: row.username,
        action: 'auth.login_failed',
        detail: lockedUntil ? '密码错误并触发账号锁定' : '密码错误',
        ip,
      });
      throw new AuthError('用户名或密码错误', 401);
    }

    if (row.status !== 'active') {
      this.audit.log({
        userId: row.id,
        username: row.username,
        action: 'auth.login_blocked',
        detail: '账号已禁用',
        ip,
      });
      throw new AuthError('该账号已被禁用，请联系管理员', 403);
    }

    this.db
      .prepare(
        `UPDATE user
         SET failed_logins = 0, locked_until = NULL,
             last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(row.id);

    this.audit.log({
      userId: row.id,
      username: row.username,
      action: 'auth.login',
      ip,
    });
    return rowToAuthUser(row);
  }

  changeOwnPassword(userId: number, currentPassword: string, newPassword: string, ip?: string): void {
    const row = this.db
      .prepare('SELECT id, username, password_hash FROM user WHERE id = ?')
      .get(userId) as { id: number; username: string; password_hash: string } | undefined;
    if (!row) throw new AuthError('用户不存在', 404);
    if (!verifyPasswordHash(currentPassword ?? '', row.password_hash)) {
      throw new AuthError('当前密码不正确', 400);
    }
    validateNewPassword(newPassword);
    this.db
      .prepare(
        `UPDATE user
         SET password_hash = ?, must_change_password = 0,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(hashPassword(newPassword), userId);

    // Remove the plaintext initial password file once admin changes password.
    if (this.dataDir && row.username.toLowerCase() === ADMIN_USERNAME) {
      const filePath = join(this.dataDir, INITIAL_ADMIN_PASSWORD_FILE);
      if (existsSync(filePath)) {
        try {
          rmSync(filePath, { force: true });
        } catch {
          // ignore cleanup failure
        }
      }
    }

    this.audit.log({
      userId: row.id,
      username: row.username,
      action: 'user.password_change',
      target: row.username,
      ip,
    });
  }

  updateOwnProfile(userId: number, input: { displayName?: string; email?: string | null }): AuthUser {
    const current = this.getUserById(userId);
    if (!current) throw new AuthError('用户不存在', 404);
    const displayName =
      input.displayName !== undefined ? input.displayName.trim() || current.displayName : current.displayName;
    const email = input.email !== undefined ? (input.email?.trim() || null) : current.email;
    this.db
      .prepare(
        `UPDATE user
         SET display_name = ?, email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(displayName, email, userId);
    return this.getUserById(userId)!;
  }

  /** Used in tests / scripts to bootstrap an admin directly without setup code. */
  bootstrapAdminForTest(username: string, password: string): AuthUser {
    const existing = this.db
      .prepare('SELECT id FROM user WHERE username = ?')
      .get(username) as { id: number } | undefined;
    const hash = hashPassword(password);
    if (existing) {
      this.db
        .prepare('UPDATE user SET password_hash = ?, status = ?, is_super_admin = 1 WHERE id = ?')
        .run(hash, 'active', existing.id);
      return this.getUserById(existing.id)!;
    }
    const superRole = this.db
      .prepare("SELECT id FROM role WHERE name = '超级管理员' LIMIT 1")
      .get() as { id: number } | undefined;
    const info = this.db
      .prepare(
        `INSERT INTO user (username, display_name, password_hash, role_id, is_super_admin, status)
         VALUES (?, '超级管理员', ?, ?, 1, 'active')`
      )
      .run(username, hash, superRole?.id ?? null);
    return this.getUserById(Number(info.lastInsertRowid))!;
  }
}
