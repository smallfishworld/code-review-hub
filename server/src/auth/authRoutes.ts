import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import {
  ADMIN_USERNAME,
  AdminPasswordAuthenticator,
  SessionStore,
  type AuthUser,
} from './authenticator.js';

/**
 * Auth API + request guard (task 7.1).
 *
 * GET  /api/auth/status   -> { mode, loginRequired, authenticated, username }
 * POST /api/auth/login    -> { token, user }   (401 on bad credentials)
 * POST /api/auth/logout   -> 204
 * POST /api/auth/password -> set/change the admin password (first run allowed)
 *
 * When no password is configured the console is open (bootstrap); the first
 * password set enables the guard. The guard is registered as an onRequest hook
 * for `/api/*` except the auth endpoints and `/api/health`.
 */

export const SESSION_COOKIE = 'crp_session';

export interface AuthOptions {
  /** Disable the guard entirely (tests / trusted deployments). */
  loginRequired?: boolean;
}

export function buildAuthRoutes(
  db: Database.Database,
  options: AuthOptions = {}
): {
  register: (app: FastifyInstance) => void;
  authenticator: AdminPasswordAuthenticator;
  sessions: SessionStore;
  guard: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
} {
  const authenticator = new AdminPasswordAuthenticator(db);
  const sessions = new SessionStore();

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

  const currentUser = (req: FastifyRequest): AuthUser | null => sessions.get(tokenOf(req));

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (options.loginRequired === false) return;
    if (!authenticator.isConfigured()) return; // bootstrap: no password yet
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (
      url === '/api/health' ||
      url === '/api/auth/status' ||
      url === '/api/auth/login' ||
      url === '/api/auth/password'
    ) {
      return;
    }
    if (!currentUser(req)) {
      await reply.code(401).send({ message: '未登录或会话已过期' });
    }
  };

  const register = (app: FastifyInstance) => {
    app.addHook('onRequest', guard);

    app.get('/api/auth/status', async (req) => {
      const user = currentUser(req);
      return {
        ...authenticator.describe(),
        authenticated: Boolean(user),
        username: user?.username ?? null,
        displayName: user?.displayName ?? null,
        mode: 'admin-password',
      };
    });

    app.post('/api/auth/login', async (req, reply) => {
      const body = (req.body ?? {}) as { username?: string; password?: string };
      const user = await authenticator.verify(
        body.username?.trim() || ADMIN_USERNAME,
        body.password ?? ''
      );
      if (!user) return reply.code(401).send({ message: '用户名或口令错误' });
      const token = sessions.create(user);
      reply.header(
        'set-cookie',
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`
      );
      return { token, user };
    });

    app.post('/api/auth/logout', async (req, reply) => {
      sessions.destroy(tokenOf(req));
      reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      return reply.code(204).send();
    });

    app.post('/api/auth/password', async (req, reply) => {
      const body = (req.body ?? {}) as { password?: string; currentPassword?: string };
      // Changing an existing password requires the current one; first-run
      // setup does not.
      if (authenticator.isConfigured()) {
        const user = currentUser(req);
        if (!user) return reply.code(401).send({ message: '未登录或会话已过期' });
        const ok = await authenticator.verify(
          ADMIN_USERNAME,
          body.currentPassword ?? ''
        );
        if (!ok) return reply.code(400).send({ message: '当前口令不正确' });
      }
      try {
        authenticator.setPassword(body.password ?? '');
      } catch (err) {
        return reply.code(400).send({ message: (err as Error).message });
      }
      return { ok: true };
    });
  };

  return { register, authenticator, sessions, guard };
}
