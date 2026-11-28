import type Database from 'better-sqlite3';
import {
  AuthError,
  AuditLogger,
  SessionStore,
  hashPassword,
  validateNewPassword,
  validateUsername,
  type AuthUser,
} from './authenticator.js';
import {
  normalizePermissions,
  parsePermissionsJson,
  type Permission,
} from './permissions.js';

/**
 * Role, User, and Registration management services.
 *
 * Key invariants:
 * - Users are never hard-deleted (status = 'disabled' only), keeping audit trails intact.
 * - Super admins can create/promote/demote other super admins, as long as at least
 *   one active super admin remains.
 * - Non-super-admin users with `user:manage` cannot modify super admins, grant
 *   `isSuperAdmin`, or assign permissions they do not themselves hold.
 */

export interface RoleDto {
  id: number;
  name: string;
  description: string;
  permissions: Permission[];
  builtin: boolean;
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserDto {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  roleId: number | null;
  roleName: string | null;
  isSuperAdmin: boolean;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegistrationDto {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  roleId: number | null;
  roleName: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  ip: string | null;
  createdAt: string;
}

export class RoleService {
  constructor(
    private readonly db: Database.Database,
    private readonly audit: AuditLogger
  ) {}

  list(): RoleDto[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM user u WHERE u.role_id = r.id) AS user_count
         FROM role r ORDER BY r.builtin DESC, r.id ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: number): RoleDto | null {
    const row = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM user u WHERE u.role_id = r.id) AS user_count
         FROM role r WHERE r.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDto(row) : null;
  }

  create(
    actor: AuthUser,
    input: { name: string; description?: string; permissions: unknown },
    ip?: string
  ): RoleDto {
    const name = (input.name ?? '').trim();
    if (!name || name.length > 40) throw new AuthError('角色名称需为 1–40 字符');
    const perms = normalizePermissions(input.permissions);
    assertCanGrantPermissions(actor, perms);
    try {
      const info = this.db
        .prepare('INSERT INTO role (name, description, permissions, builtin) VALUES (?, ?, ?, 0)')
        .run(name, (input.description ?? '').trim(), JSON.stringify(perms));
      const created = this.get(Number(info.lastInsertRowid))!;
      this.audit.log({
        userId: actor.id,
        username: actor.username,
        action: 'role.create',
        target: created.name,
        detail: `权限：${perms.join(', ') || '无'}`,
        ip,
      });
      return created;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AuthError(`角色「${name}」已存在`, 409);
      throw err;
    }
  }

  update(
    actor: AuthUser,
    id: number,
    input: { name?: string; description?: string; permissions?: unknown },
    ip?: string
  ): RoleDto {
    const current = this.get(id);
    if (!current) throw new AuthError('角色不存在', 404);
    if (current.name === '超级管理员') {
      throw new AuthError('「超级管理员」内置角色权限不可修改', 400);
    }
    const name = input.name !== undefined ? input.name.trim() : current.name;
    if (!name || name.length > 40) throw new AuthError('角色名称需为 1–40 字符');
    if (current.builtin && name !== current.name) {
      throw new AuthError('内置角色名称不可修改', 400);
    }
    const perms =
      input.permissions !== undefined ? normalizePermissions(input.permissions) : current.permissions;
    assertCanGrantPermissions(actor, perms);
    try {
      this.db
        .prepare(
          `UPDATE role
           SET name = ?, description = ?, permissions = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`
        )
        .run(
          name,
          input.description !== undefined ? input.description.trim() : current.description,
          JSON.stringify(perms),
          id
        );
      const updated = this.get(id)!;
      this.audit.log({
        userId: actor.id,
        username: actor.username,
        action: 'role.update',
        target: updated.name,
        detail: `权限：${perms.join(', ') || '无'}`,
        ip,
      });
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AuthError(`角色「${name}」已存在`, 409);
      throw err;
    }
  }

  delete(actor: AuthUser, id: number, ip?: string): void {
    const current = this.get(id);
    if (!current) throw new AuthError('角色不存在', 404);
    if (current.builtin) throw new AuthError('内置角色不可删除', 400);
    if (current.userCount > 0) {
      throw new AuthError(`仍有 ${current.userCount} 个用户使用该角色，请先调整用户角色`, 409);
    }
    this.db.prepare('DELETE FROM role WHERE id = ?').run(id);
    this.audit.log({
      userId: actor.id,
      username: actor.username,
      action: 'role.delete',
      target: current.name,
      ip,
    });
  }

  private toDto(r: Record<string, unknown>): RoleDto {
    return {
      id: r.id as number,
      name: r.name as string,
      description: (r.description as string) ?? '',
      permissions: parsePermissionsJson(r.permissions as string),
      builtin: r.builtin === 1,
      userCount: Number(r.user_count ?? 0),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }
}

export class UserService {
  constructor(
    private readonly db: Database.Database,
    private readonly sessions: SessionStore,
    private readonly audit: AuditLogger,
    private readonly roles: RoleService
  ) {}

  list(): UserDto[] {
    const rows = this.db
      .prepare(
        `SELECT u.*, r.name AS role_name
         FROM user u LEFT JOIN role r ON r.id = u.role_id
         ORDER BY u.is_super_admin DESC, u.id ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: number): UserDto | null {
    const row = this.db
      .prepare(
        `SELECT u.*, r.name AS role_name
         FROM user u LEFT JOIN role r ON r.id = u.role_id
         WHERE u.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDto(row) : null;
  }

  create(
    actor: AuthUser,
    input: {
      username: string;
      displayName?: string;
      email?: string | null;
      password: string;
      roleId?: number | null;
      isSuperAdmin?: boolean;
      mustChangePassword?: boolean;
    },
    ip?: string
  ): UserDto {
    const username = validateUsername(input.username);
    const displayName = (input.displayName ?? '').trim() || username;
    const email = (input.email ?? '').trim() || null;
    validateNewPassword(input.password);

    const isSuperAdmin = Boolean(input.isSuperAdmin);
    if (isSuperAdmin && !actor.isSuperAdmin) {
      throw new AuthError('只有超级管理员可以创建超级管理员账号', 403);
    }

    let roleId: number | null = input.roleId ?? null;
    if (isSuperAdmin) {
      const superRole = this.db
        .prepare("SELECT id FROM role WHERE name = '超级管理员' LIMIT 1")
        .get() as { id: number } | undefined;
      roleId = superRole?.id ?? roleId;
    } else {
      if (!roleId) throw new AuthError('请为该用户选择一个角色', 400);
      const role = this.roles.get(roleId);
      if (!role) throw new AuthError('所选角色不存在', 400);
      if (role.name === '超级管理员') {
        throw new AuthError('如需赋予超级管理员权限，请勾选「设为超级管理员」', 400);
      }
      assertCanGrantPermissions(actor, role.permissions);
    }

    try {
      const info = this.db
        .prepare(
          `INSERT INTO user
             (username, display_name, email, password_hash, role_id, is_super_admin, status, must_change_password, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
        )
        .run(
          username,
          displayName,
          email,
          hashPassword(input.password),
          roleId,
          isSuperAdmin ? 1 : 0,
          input.mustChangePassword === false ? 0 : 1,
          actor.id
        );
      const created = this.get(Number(info.lastInsertRowid))!;
      this.audit.log({
        userId: actor.id,
        username: actor.username,
        action: 'user.create',
        target: created.username,
        detail: created.isSuperAdmin ? '角色：超级管理员' : `角色：${created.roleName ?? ''}`,
        ip,
      });
      return created;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AuthError(`用户名「${username}」已存在`, 409);
      throw err;
    }
  }

  update(
    actor: AuthUser,
    id: number,
    input: {
      displayName?: string;
      email?: string | null;
      roleId?: number | null;
      isSuperAdmin?: boolean;
      status?: 'active' | 'disabled';
    },
    ip?: string
  ): UserDto {
    const target = this.get(id);
    if (!target) throw new AuthError('用户不存在', 404);

    if (target.isSuperAdmin && !actor.isSuperAdmin) {
      throw new AuthError('只有超级管理员可以修改超级管理员账号', 403);
    }

    const nextSuper = input.isSuperAdmin !== undefined ? Boolean(input.isSuperAdmin) : target.isSuperAdmin;
    const nextStatus = input.status ?? target.status;
    if (nextStatus !== 'active' && nextStatus !== 'disabled') {
      throw new AuthError('用户状态无效', 400);
    }

    if (nextSuper !== target.isSuperAdmin && !actor.isSuperAdmin) {
      throw new AuthError('只有超级管理员可以提权或取消超级管理员', 403);
    }

    // Protect against disabling self.
    if (target.id === actor.id && nextStatus === 'disabled') {
      throw new AuthError('不能禁用当前登录的账号', 400);
    }

    let nextRoleId = input.roleId !== undefined ? input.roleId : target.roleId;
    if (nextSuper) {
      const superRole = this.db
        .prepare("SELECT id FROM role WHERE name = '超级管理员' LIMIT 1")
        .get() as { id: number } | undefined;
      nextRoleId = superRole?.id ?? nextRoleId;
    } else if (input.roleId !== undefined || (!nextSuper && target.isSuperAdmin)) {
      if (!nextRoleId) throw new AuthError('请为用户指定一个角色', 400);
      const role = this.roles.get(nextRoleId);
      if (!role) throw new AuthError('所选角色不存在', 400);
      if (role.name === '超级管理员') {
        throw new AuthError('非超级管理员不能绑定「超级管理员」角色', 400);
      }
      assertCanGrantPermissions(actor, role.permissions);
    }

    const displayName =
      input.displayName !== undefined ? input.displayName.trim() || target.displayName : target.displayName;
    const email = input.email !== undefined ? (input.email?.trim() || null) : target.email;

    // Atomically enforce "at least one active super admin" and persist the update.
    // Re-enabling an account also clears any prior login lockout.
    const tx = this.db.transaction(() => {
      if (target.isSuperAdmin && (!nextSuper || nextStatus === 'disabled')) {
        const activeSuperCount = (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM user WHERE is_super_admin = 1 AND status = 'active'")
            .get() as { n: number }
        ).n;
        if (activeSuperCount <= 1) {
          throw new AuthError('系统至少需要保留一个启用状态的超级管理员', 400);
        }
      }
      if (nextStatus === 'active' && target.status !== 'active') {
        this.db
          .prepare(
            `UPDATE user
             SET display_name = ?, email = ?, role_id = ?, is_super_admin = ?, status = ?,
                 failed_logins = 0, locked_until = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?`
          )
          .run(displayName, email, nextRoleId, nextSuper ? 1 : 0, nextStatus, id);
      } else {
        this.db
          .prepare(
            `UPDATE user
             SET display_name = ?, email = ?, role_id = ?, is_super_admin = ?, status = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?`
          )
          .run(displayName, email, nextRoleId, nextSuper ? 1 : 0, nextStatus, id);
      }
    });
    tx.immediate();

    if (nextStatus === 'disabled') {
      this.sessions.destroyAllForUser(id);
    }

    const updated = this.get(id)!;
    const changes: string[] = [];
    if (updated.status !== target.status) changes.push(`状态:${updated.status}`);
    if (updated.isSuperAdmin !== target.isSuperAdmin) {
      changes.push(updated.isSuperAdmin ? '提权为超级管理员' : '取消超级管理员');
    }
    if (updated.roleId !== target.roleId) changes.push(`角色:${updated.roleName ?? ''}`);
    this.audit.log({
      userId: actor.id,
      username: actor.username,
      action: 'user.update',
      target: updated.username,
      detail: changes.join('，') || '更新资料',
      ip,
    });
    return updated;
  }

  resetPassword(actor: AuthUser, id: number, newPassword: string, ip?: string): void {
    const target = this.get(id);
    if (!target) throw new AuthError('用户不存在', 404);
    if (target.isSuperAdmin && !actor.isSuperAdmin) {
      throw new AuthError('只有超级管理员可以重置超级管理员密码', 403);
    }
    validateNewPassword(newPassword);
    this.db
      .prepare(
        `UPDATE user
         SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(hashPassword(newPassword), id);
    this.sessions.destroyAllForUser(id);
    this.audit.log({
      userId: actor.id,
      username: actor.username,
      action: 'user.reset_password',
      target: target.username,
      detail: '重置密码并强制下次登录修改',
      ip,
    });
  }

  private toDto(r: Record<string, unknown>): UserDto {
    return {
      id: r.id as number,
      username: r.username as string,
      displayName: r.display_name as string,
      email: (r.email as string | null) ?? null,
      roleId: (r.role_id as number | null) ?? null,
      roleName: (r.role_name as string | null) ?? null,
      isSuperAdmin: r.is_super_admin === 1,
      status: r.status as 'active' | 'disabled',
      mustChangePassword: r.must_change_password === 1,
      lastLoginAt: (r.last_login_at as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }
}

export class RegistrationService {
  private readonly ipAttempts = new Map<string, number[]>();

  constructor(
    private readonly db: Database.Database,
    private readonly audit: AuditLogger,
    private readonly roles: RoleService,
    private readonly options: {
      onSubmitted?: (req: RegistrationDto) => void;
      maxPerHourPerIp?: number;
    } = {}
  ) {}

  isEnabled(): boolean {
    const row = this.db
      .prepare("SELECT value FROM setting WHERE key = 'registration_enabled'")
      .get() as { value: string } | undefined;
    return row?.value !== '0';
  }

  setEnabled(actor: AuthUser, enabled: boolean, ip?: string): boolean {
    this.db
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('registration_enabled', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(enabled ? '1' : '0');
    this.audit.log({
      userId: actor.id,
      username: actor.username,
      action: 'settings.registration',
      detail: enabled ? '开启注册申请' : '关闭注册申请',
      ip,
    });
    return enabled;
  }

  submit(
    input: {
      username: string;
      displayName?: string;
      email?: string | null;
      password: string;
      reason?: string;
      website?: string; // honeypot
    },
    ip?: string
  ): RegistrationDto {
    if (!this.isEnabled()) {
      throw new AuthError('系统已关闭自助注册申请，请联系管理员创建账号', 403);
    }
    if (input.website && input.website.trim() !== '') {
      throw new AuthError('提交异常', 400);
    }
    this.checkRateLimit(ip ?? 'unknown');

    const username = validateUsername(input.username);
    const displayName = (input.displayName ?? '').trim() || username;
    const email = (input.email ?? '').trim() || null;
    const reason = (input.reason ?? '').trim().slice(0, 500);
    validateNewPassword(input.password);

    const passwordHash = hashPassword(input.password);
    const tx = this.db.transaction(() => {
      const existingUser = this.db.prepare('SELECT 1 FROM user WHERE username = ?').get(username);
      if (existingUser) {
        throw new AuthError(`用户名「${username}」已被占用`, 409);
      }
      const existingPending = this.db
        .prepare("SELECT 1 FROM registration_request WHERE username = ? AND status = 'pending'")
        .get(username);
      if (existingPending) {
        throw new AuthError(`用户名「${username}」已有待审核的申请`, 409);
      }
      const info = this.db
        .prepare(
          `INSERT INTO registration_request (username, display_name, email, reason, password_hash, status, ip)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(username, displayName, email, reason, passwordHash, ip ?? null);
      return Number(info.lastInsertRowid);
    });

    const reqId = tx.immediate();
    const created = this.get(reqId)!;
    this.audit.log({
      username: created.username,
      action: 'registration.submit',
      target: created.username,
      detail: reason ? `申请理由：${reason.slice(0, 100)}` : undefined,
      ip,
    });
    this.options.onSubmitted?.(created);
    return created;
  }

  list(status?: 'pending' | 'approved' | 'rejected' | 'all'): RegistrationDto[] {
    const rows = (
      status && status !== 'all'
        ? this.db
            .prepare(
              `SELECT rr.*, r.name AS role_name, u.display_name AS reviewed_by_name
               FROM registration_request rr
               LEFT JOIN role r ON r.id = rr.role_id
               LEFT JOIN user u ON u.id = rr.reviewed_by
               WHERE rr.status = ?
               ORDER BY rr.id DESC`
            )
            .all(status)
        : this.db
            .prepare(
              `SELECT rr.*, r.name AS role_name, u.display_name AS reviewed_by_name
               FROM registration_request rr
               LEFT JOIN role r ON r.id = rr.role_id
               LEFT JOIN user u ON u.id = rr.reviewed_by
               ORDER BY (rr.status = 'pending') DESC, rr.id DESC`
            )
            .all()
    ) as Record<string, unknown>[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: number): RegistrationDto | null {
    const row = this.db
      .prepare(
        `SELECT rr.*, r.name AS role_name, u.display_name AS reviewed_by_name
         FROM registration_request rr
         LEFT JOIN role r ON r.id = rr.role_id
         LEFT JOIN user u ON u.id = rr.reviewed_by
         WHERE rr.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toDto(row) : null;
  }

  pendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM registration_request WHERE status = 'pending'")
      .get() as { n: number };
    return row.n;
  }

  approve(
    actor: AuthUser,
    id: number,
    input: { roleId?: number | null; isSuperAdmin?: boolean },
    ip?: string
  ): { request: RegistrationDto; userId: number } {
    const raw = this.db
      .prepare('SELECT * FROM registration_request WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!raw) throw new AuthError('注册申请不存在', 404);
    if (raw.status !== 'pending') throw new AuthError('该申请已处理', 409);

    const isSuperAdmin = Boolean(input.isSuperAdmin);
    if (isSuperAdmin && !actor.isSuperAdmin) {
      throw new AuthError('只有超级管理员可以审批为超级管理员', 403);
    }

    let roleId: number | null = input.roleId ?? null;
    if (isSuperAdmin) {
      const superRole = this.db
        .prepare("SELECT id FROM role WHERE name = '超级管理员' LIMIT 1")
        .get() as { id: number } | undefined;
      roleId = superRole?.id ?? roleId;
    } else {
      if (!roleId) throw new AuthError('审批通过时必须指定角色', 400);
      const role = this.roles.get(roleId);
      if (!role) throw new AuthError('所选角色不存在', 400);
      if (role.name === '超级管理员') {
        throw new AuthError('如需赋予超级管理员权限，请勾选「设为超级管理员」', 400);
      }
      assertCanGrantPermissions(actor, role.permissions);
    }

    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT 1 FROM user WHERE username = ?')
        .get(raw.username as string);
      if (existing) {
        throw new AuthError(`用户名「${raw.username as string}」已被其他账号占用`, 409);
      }
      const userInfo = this.db
        .prepare(
          `INSERT INTO user
             (username, display_name, email, password_hash, role_id, is_super_admin, status, must_change_password, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?)`
        )
        .run(
          raw.username as string,
          raw.display_name as string,
          (raw.email as string | null) ?? null,
          raw.password_hash as string,
          roleId,
          isSuperAdmin ? 1 : 0,
          actor.id
        );
      this.db
        .prepare(
          `UPDATE registration_request
           SET status = 'approved', role_id = ?, reviewed_by = ?,
               reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`
        )
        .run(roleId, actor.id, id);
      return Number(userInfo.lastInsertRowid);
    });

    const userId = tx.immediate();
    const request = this.get(id)!;
    this.audit.log({
      userId: actor.id,
      username: actor.username,
      action: 'registration.approve',
      target: request.username,
      detail: isSuperAdmin ? '角色：超级管理员' : `角色：${request.roleName ?? ''}`,
      ip,
    });
    return { request, userId };
  }

  reject(actor: AuthUser, id: number, reason?: string, ip?: string): RegistrationDto {
    const raw = this.db
      .prepare('SELECT id, username, status FROM registration_request WHERE id = ?')
      .get(id) as { id: number; username: string; status: string } | undefined;
    if (!raw) throw new AuthError('注册申请不存在', 404);
    if (raw.status !== 'pending') throw new AuthError('该申请已处理', 409);
    const trimmed = (reason ?? '').trim().slice(0, 500) || null;
    this.db
      .prepare(
        `UPDATE registration_request
         SET status = 'rejected', reject_reason = ?, reviewed_by = ?,
             reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(trimmed, actor.id, id);
    const updated = this.get(id)!;
    this.audit.log({
      userId: actor.id,
      username: actor.username,
      action: 'registration.reject',
      target: updated.username,
      detail: trimmed ?? undefined,
      ip,
    });
    return updated;
  }

  private checkRateLimit(ip: string): void {
    const max = this.options.maxPerHourPerIp ?? 10;
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    // Periodically prune expired IP buckets so the in-memory Map stays bounded.
    if (this.ipAttempts.size > 200) {
      for (const [key, timestamps] of this.ipAttempts) {
        const fresh = timestamps.filter((t) => t > cutoff);
        if (fresh.length === 0) this.ipAttempts.delete(key);
        else this.ipAttempts.set(key, fresh);
      }
    }
    const list = (this.ipAttempts.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length >= max) {
      throw new AuthError('提交过于频繁，请稍后再试', 429);
    }
    list.push(now);
    this.ipAttempts.set(ip, list);
  }

  private toDto(r: Record<string, unknown>): RegistrationDto {
    return {
      id: r.id as number,
      username: r.username as string,
      displayName: r.display_name as string,
      email: (r.email as string | null) ?? null,
      reason: (r.reason as string) ?? '',
      status: r.status as 'pending' | 'approved' | 'rejected',
      roleId: (r.role_id as number | null) ?? null,
      roleName: (r.role_name as string | null) ?? null,
      reviewedBy: (r.reviewed_by as number | null) ?? null,
      reviewedByName: (r.reviewed_by_name as string | null) ?? null,
      reviewedAt: (r.reviewed_at as string | null) ?? null,
      rejectReason: (r.reject_reason as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }
}

function assertCanGrantPermissions(actor: AuthUser, perms: Permission[]): void {
  if (actor.isSuperAdmin) return;
  for (const p of perms) {
    if (!actor.permissions.includes(p)) {
      throw new AuthError(`您没有权限「${p}」，不能将其授予他人或角色`, 403);
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
