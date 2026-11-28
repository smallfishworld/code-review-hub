import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import {
  AuthError,
  AuthService,
  AuditLogger,
  SessionStore,
  hasPermission,
  type AuthUser,
  type InitialAdminCredentials,
} from './authenticator.js';
import { ALL_PERMISSIONS, requiredAccessFor } from './permissions.js';
import {
  RegistrationService,
  RoleService,
  UserService,
  type RegistrationDto,
} from './userService.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser | null;
  }
}

export const SESSION_COOKIE = 'crp_session';

export interface AuthOptions {
  /** Disable the guard entirely (tests / trusted deployments). */
  loginRequired?: boolean;
  /** Data directory where initial-admin-password.txt is written on first run. */
  dataDir?: string;
  /** Optional explicit initial password for `admin` (defaults to random 12-char password). */
  initialAdminPassword?: string;
  /** Optional hook invoked when a new registration request is submitted. */
  onRegistrationSubmitted?: (req: RegistrationDto) => void;
  /** Max registration submissions per IP per hour. */
  maxRegistrationsPerHourPerIp?: number;
}

const SYNTHETIC_ADMIN: AuthUser = {
  id: 0,
  username: 'admin',
  displayName: '管理员',
  email: null,
  roleId: null,
  roleName: '超级管理员',
  isSuperAdmin: true,
  permissions: ALL_PERMISSIONS.map((p) => p.id),
  mustChangePassword: false,
  status: 'active',
};

export function clientIpOf(req: FastifyRequest): string {
  // Rely on Fastify's req.ip (which respects trustProxy when explicitly enabled)
  // rather than blindly trusting spoofable X-Forwarded-For headers.
  return req.ip || '';
}

function parsePositiveId(raw: string): number {
  const n = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AuthError('ID 参数必须为正整数', 400);
  }
  return n;
}

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/logout',
  '/api/me',
  '/api/me/password',
  '/api/auth/password',
]);

export function buildAuthRoutes(
  db: Database.Database,
  options: AuthOptions = {}
): {
  register: (app: FastifyInstance) => void;
  auth: AuthService;
  sessions: SessionStore;
  roles: RoleService;
  users: UserService;
  registrations: RegistrationService;
  audit: AuditLogger;
  initialAdmin: InitialAdminCredentials | null;
  guard: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
} {
  const sessions = new SessionStore(db);
  const audit = new AuditLogger(db);
  const auth = new AuthService(db, sessions, audit, {
    dataDir: options.dataDir,
    initialAdminPassword: options.initialAdminPassword,
    autoBootstrap: options.loginRequired !== false,
  });
  const roles = new RoleService(db, audit);
  const users = new UserService(db, sessions, audit, roles);
  const registrations = new RegistrationService(db, audit, roles, {
    onSubmitted: options.onRegistrationSubmitted,
    maxPerHourPerIp: options.maxRegistrationsPerHourPerIp,
  });

  sessions.pruneExpired();

  const tokenOf = (req: FastifyRequest): string | undefined => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = req.headers.cookie;
    if (cookie) {
      for (const part of cookie.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
      }
    }
    return undefined;
  };

  const currentUser = (req: FastifyRequest): AuthUser | null => {
    if (options.loginRequired === false) return SYNTHETIC_ADMIN;
    return sessions.get(tokenOf(req));
  };

  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`
    );
  };

  const handleErr = (err: unknown, reply: FastifyReply) => {
    if (err instanceof AuthError) {
      return reply.code(err.statusCode).send({
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    throw err;
  };

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (options.loginRequired === false) {
      req.authUser = SYNTHETIC_ADMIN;
      return;
    }
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;

    const access = requiredAccessFor(req.method, url);
    if (access === 'public') {
      req.authUser = sessions.get(tokenOf(req));
      return;
    }

    const user = sessions.get(tokenOf(req));
    if (!user) {
      await reply.code(401).send({ message: '未登录或会话已过期' });
      return;
    }
    req.authUser = user;

    // Enforce forced password change on the backend (not just the UI).
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.has(url)) {
      await reply.code(403).send({
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: '请先修改初始密码后再继续操作',
      });
      return;
    }

    if (access === 'authenticated') return;
    if (access === 'super_admin') {
      if (!user.isSuperAdmin) {
        await reply.code(403).send({ message: '无权限执行此操作' });
      }
      return;
    }
    if (!hasPermission(user, access)) {
      await reply.code(403).send({ message: '无权限执行此操作' });
    }
  };

  const register = (app: FastifyInstance) => {
    app.addHook('onRequest', guard);

    // --- Public auth endpoints ---------------------------------------------

    app.get('/api/auth/status', async (req) => {
      const loginRequired = options.loginRequired !== false;
      const user = currentUser(req);
      const canManageUsers = Boolean(user && hasPermission(user, 'user:manage'));
      return {
        mode: 'rbac',
        loginRequired,
        registrationEnabled: registrations.isEnabled(),
        authenticated: Boolean(user),
        username: user?.username ?? null,
        displayName: user?.displayName ?? null,
        pendingRegistrations: canManageUsers ? registrations.pendingCount() : 0,
        user: user
          ? {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              email: user.email,
              roleId: user.roleId,
              roleName: user.roleName,
              isSuperAdmin: user.isSuperAdmin,
              permissions: user.permissions,
              mustChangePassword: user.mustChangePassword,
            }
          : null,
      };
    });

    app.post('/api/auth/login', async (req, reply) => {
      const body = (req.body ?? {}) as { username?: string; password?: string };
      try {
        const user = auth.login(body.username ?? '', body.password ?? '', clientIpOf(req));
        const token = sessions.create(user.id, {
          ip: clientIpOf(req),
          userAgent: String(req.headers['user-agent'] ?? ''),
        });
        setSessionCookie(reply, token);
        return { token, user };
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.post('/api/auth/logout', async (req, reply) => {
      sessions.destroy(tokenOf(req));
      reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      return reply.code(204).send();
    });

    app.post('/api/auth/register', async (req, reply) => {
      const body = (req.body ?? {}) as {
        username?: string;
        displayName?: string;
        email?: string;
        password?: string;
        reason?: string;
        website?: string;
      };
      try {
        const created = registrations.submit(
          {
            username: body.username ?? '',
            displayName: body.displayName,
            email: body.email,
            password: body.password ?? '',
            reason: body.reason,
            website: body.website,
          },
          clientIpOf(req)
        );
        return reply.code(201).send({
          id: created.id,
          username: created.username,
          status: created.status,
          message: '注册申请已提交，请等待管理员审批',
        });
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    // --- Self account endpoints --------------------------------------------

    app.get('/api/me', async (req, reply) => {
      const user = req.authUser ?? currentUser(req);
      if (!user) return reply.code(401).send({ message: '未登录或会话已过期' });
      return user;
    });

    app.put('/api/me', async (req, reply) => {
      const user = req.authUser ?? currentUser(req);
      if (!user || user.id === 0) return reply.code(401).send({ message: '未登录或会话已过期' });
      const body = (req.body ?? {}) as { displayName?: string; email?: string | null };
      try {
        return auth.updateOwnProfile(user.id, {
          displayName: body.displayName,
          email: body.email,
        });
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    const changePasswordHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.authUser ?? currentUser(req);
      if (!user || user.id === 0) return reply.code(401).send({ message: '未登录或会话已过期' });
      const body = (req.body ?? {}) as { password?: string; currentPassword?: string };
      try {
        auth.changeOwnPassword(user.id, body.currentPassword ?? '', body.password ?? '', clientIpOf(req));
        // Revoke all other active sessions for this user while keeping the current one.
        sessions.destroyOtherForUser(user.id, tokenOf(req));
        return { ok: true };
      } catch (err) {
        return handleErr(err, reply);
      }
    };
    app.post('/api/me/password', changePasswordHandler);
    app.post('/api/auth/password', changePasswordHandler);

    // --- Admin RBAC management endpoints (all gated by user:manage) --------

    app.get('/api/admin/permissions', async () => ALL_PERMISSIONS);

    app.get('/api/admin/roles', async () => roles.list());

    app.post('/api/admin/roles', async (req, reply) => {
      const actor = req.authUser!;
      const body = (req.body ?? {}) as { name?: string; description?: string; permissions?: unknown };
      try {
        const created = roles.create(
          actor,
          { name: body.name ?? '', description: body.description, permissions: body.permissions },
          clientIpOf(req)
        );
        return reply.code(201).send(created);
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.put('/api/admin/roles/:id', async (req, reply) => {
      const actor = req.authUser!;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { name?: string; description?: string; permissions?: unknown };
      try {
        return roles.update(actor, parsePositiveId(id), body, clientIpOf(req));
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.delete('/api/admin/roles/:id', async (req, reply) => {
      const actor = req.authUser!;
      const { id } = req.params as { id: string };
      try {
        roles.delete(actor, parsePositiveId(id), clientIpOf(req));
        return reply.code(204).send();
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.get('/api/admin/users', async () => users.list());

    app.post('/api/admin/users', async (req, reply) => {
      const actor = req.authUser!;
      const body = (req.body ?? {}) as {
        username?: string;
        displayName?: string;
        email?: string | null;
        password?: string;
        roleId?: number | null;
        isSuperAdmin?: boolean;
        mustChangePassword?: boolean;
      };
      try {
        const created = users.create(
          actor,
          {
            username: body.username ?? '',
            displayName: body.displayName,
            email: body.email,
            password: body.password ?? '',
            roleId: body.roleId,
            isSuperAdmin: body.isSuperAdmin,
            mustChangePassword: body.mustChangePassword,
          },
          clientIpOf(req)
        );
        return reply.code(201).send(created);
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.put('/api/admin/users/:id', async (req, reply) => {
      const actor = req.authUser!;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as {
        displayName?: string;
        email?: string | null;
        roleId?: number | null;
        isSuperAdmin?: boolean;
        status?: 'active' | 'disabled';
      };
      try {
        return users.update(actor, parsePositiveId(id), body, clientIpOf(req));
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
      const actor = req.authUser!;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { password?: string };
      try {
        users.resetPassword(actor, parsePositiveId(id), body.password ?? '', clientIpOf(req));
        return { ok: true };
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.get('/api/admin/registrations', async (req) => {
      const q = (req.query ?? {}) as { status?: 'pending' | 'approved' | 'rejected' | 'all' };
      return registrations.list(q.status);
    });

    app.post('/api/admin/registrations/:id/approve', async (req, reply) => {
      const actor = req.authUser!;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { roleId?: number | null; isSuperAdmin?: boolean };
      try {
        return registrations.approve(actor, parsePositiveId(id), body, clientIpOf(req));
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.post('/api/admin/registrations/:id/reject', async (req, reply) => {
      const actor = req.authUser!;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { reason?: string };
      try {
        return registrations.reject(actor, parsePositiveId(id), body.reason, clientIpOf(req));
      } catch (err) {
        return handleErr(err, reply);
      }
    });

    app.get('/api/admin/audit-logs', async (req) => {
      const q = (req.query ?? {}) as { limit?: string };
      return audit.list(q.limit ? Number(q.limit) : 100);
    });

    app.get('/api/admin/settings/registration', async () => ({
      enabled: registrations.isEnabled(),
    }));

    app.put('/api/admin/settings/registration', async (req) => {
      const actor = req.authUser!;
      const body = (req.body ?? {}) as { enabled?: boolean };
      return { enabled: registrations.setEnabled(actor, Boolean(body.enabled), clientIpOf(req)) };
    });
  };

  return {
    register,
    auth,
    sessions,
    roles,
    users,
    registrations,
    audit,
    initialAdmin: auth.initialAdmin,
    guard,
  };
}
