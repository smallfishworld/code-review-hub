import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { buildAuthRoutes } from './authRoutes.js';
import { hashPassword, verifyPasswordHash } from './authenticator.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let app: Fastify.FastifyInstance;

async function buildApp(loginRequired = true): Promise<Fastify.FastifyInstance> {
  const instance = Fastify();
  buildAuthRoutes(db, { loginRequired }).register(instance);
  // a protected business route to prove the guard works
  instance.get('/api/repos', async () => []);
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crp-auth-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  app = await buildApp();
});

afterEach(async () => {
  await app?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const login = (password: string, username = 'admin') =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

describe('admin password auth', () => {
  it('hashes passwords with scrypt and verifies them', () => {
    const stored = hashPassword('secret123');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('secret123');
    expect(verifyPasswordHash('secret123', stored)).toBe(true);
    expect(verifyPasswordHash('wrong', stored)).toBe(false);
    expect(verifyPasswordHash('secret123', 'garbage')).toBe(false);
  });

  it('is open before a password is configured (bootstrap)', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    const body = status.json() as { loginRequired: boolean; authenticated: boolean };
    expect(body.loginRequired).toBe(false);
    expect(body.authenticated).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/repos' })).statusCode).toBe(200);
  });

  it('locks protected routes once a password is set, and login unlocks them', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'admin-pass' },
    });
    expect(set.statusCode).toBe(200);

    // now the guard applies
    expect((await app.inject({ method: 'GET', url: '/api/repos' })).statusCode).toBe(401);
    expect((await login('wrong')).statusCode).toBe(401);

    const ok = await login('admin-pass');
    expect(ok.statusCode).toBe(200);
    const { token } = ok.json() as { token: string };
    expect(token).toHaveLength(64);

    const authed = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.statusCode).toBe(200);

    // cookie auth works too
    const viaCookie = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: { cookie: `crp_session=${token}` },
    });
    expect(viaCookie.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((status.json() as { authenticated: boolean }).authenticated).toBe(true);

    // logout invalidates the token
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('requires the current password to change an existing one', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'first-pass' },
    });
    const { token } = (await login('first-pass')).json() as { token: string };

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'second-pass', currentPassword: 'nope' },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'second-pass', currentPassword: 'first-pass' },
    });
    expect(good.statusCode).toBe(200);
    expect((await login('second-pass')).statusCode).toBe(200);
  });

  it('rejects short passwords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: '123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps /api/health public', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'admin-pass' },
    });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(404); // not registered in this test app
    // but it is not blocked by the guard
    expect(health.statusCode).not.toBe(401);
  });

  it('can disable the guard explicitly', async () => {
    const open = await buildApp(false);
    try {
      await open.inject({
        method: 'POST',
        url: '/api/auth/password',
        payload: { password: 'admin-pass' },
      });
      expect((await open.inject({ method: 'GET', url: '/api/repos' })).statusCode).toBe(200);
    } finally {
      await open.close();
    }
  });
});
