import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { buildAuthRoutes } from './authRoutes.js';
import {
  ADMIN_USERNAME,
  INITIAL_ADMIN_PASSWORD_FILE,
  hashPassword,
  verifyPasswordHash,
  type InitialAdminCredentials,
} from './authenticator.js';
import type Database from 'better-sqlite3';

const DEV_PASS = `Dev${randomBytes(4).toString('hex')}2`;
const OPS_PASS = `Ops${randomBytes(4).toString('hex')}3`;
const NEW_PASS = `New${randomBytes(4).toString('hex')}4`;

let dir: string;
let db: Database.Database;
let app: Fastify.FastifyInstance;
let initialAdmin: InitialAdminCredentials | null = null;
let notifiedRegs: string[] = [];

async function buildApp(loginRequired = true): Promise<Fastify.FastifyInstance> {
  const instance = Fastify();
  notifiedRegs = [];
  const routes = buildAuthRoutes(db, {
    loginRequired,
    dataDir: dir,
    onRegistrationSubmitted: (r) => notifiedRegs.push(r.username),
  });
  initialAdmin = routes.initialAdmin;
  routes.register(instance);
  // Representative protected business routes for permission matrix checks
  instance.get('/api/repos', async () => []);
  instance.post('/api/repos', async () => ({ ok: true }));
  instance.post('/api/providers', async () => ({ ok: true }));
  instance.get('/api/logs', async () => ({ items: [] }));
  instance.post('/api/repos/1/review', async () => ({ ok: true }));
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

const login = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

const loginAdmin = async (): Promise<string> => {
  const res = await login(ADMIN_USERNAME, initialAdmin!.password);
  expect(res.statusCode).toBe(200);
  const { token } = res.json() as { token: string };
  // Complete forced initial password change so admin can call protected APIs
  const ch = await app.inject({
    method: 'POST',
    url: '/api/me/password',
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: initialAdmin!.password, password: NEW_PASS },
  });
  expect(ch.statusCode).toBe(200);
  return token;
};

describe('RBAC auth & permission system', () => {
  it('hashes passwords with scrypt and verifies them', () => {
    const stored = hashPassword('Secret1234');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('Secret1234');
    expect(verifyPasswordHash('Secret1234', stored)).toBe(true);
    expect(verifyPasswordHash('wrong', stored)).toBe(false);
    expect(verifyPasswordHash('Secret1234', 'garbage')).toBe(false);
  });

  it('auto-creates initial admin with random password file and deletes file after password change', async () => {
    expect(initialAdmin).not.toBeNull();
    expect(initialAdmin!.username).toBe('admin');
    expect(initialAdmin!.password.length).toBeGreaterThanOrEqual(8);

    const pwdFile = join(dir, INITIAL_ADMIN_PASSWORD_FILE);
    expect(existsSync(pwdFile)).toBe(true);
    expect(readFileSync(pwdFile, 'utf8')).toContain(initialAdmin!.password);

    // Unauthenticated access returns 401
    expect((await app.inject({ method: 'GET', url: '/api/repos' })).statusCode).toBe(401);

    // Login with initial password succeeds and flags mustChangePassword
    const loginRes = await login('admin', initialAdmin!.password);
    expect(loginRes.statusCode).toBe(200);
    const { token, user } = loginRes.json() as {
      token: string;
      user: { isSuperAdmin: boolean; mustChangePassword: boolean };
    };
    expect(user.isSuperAdmin).toBe(true);
    expect(user.mustChangePassword).toBe(true);

    // Second login creates another session to verify revocation on password change
    const otherToken = ((await login('admin', initialAdmin!.password)).json() as { token: string }).token;

    // Backend enforces mustChangePassword before allowing business/admin routes
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { code: string }).code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Changing password clears mustChangePassword, revokes other sessions, and removes password file
    const chPwd = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: initialAdmin!.password, password: NEW_PASS },
    });
    expect(chPwd.statusCode).toBe(200);
    expect(existsSync(pwdFile)).toBe(false);

    // Current session now accesses protected APIs; other session was revoked
    expect(
      (await app.inject({ method: 'GET', url: '/api/repos', headers: { authorization: `Bearer ${token}` } })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/repos', headers: { authorization: `Bearer ${otherToken}` } })).statusCode
    ).toBe(401);

    // Subsequent startup on same DB does not recreate initialAdmin
    const second = buildAuthRoutes(db, { loginRequired: true, dataDir: dir });
    expect(second.initialAdmin).toBeNull();
  });

  it('enforces role permissions, super-admin promotion, disable revocation, and lockout', async () => {
    const adminToken = await loginAdmin();
    const authHeader = { authorization: `Bearer ${adminToken}` };

    const rolesRes = await app.inject({ method: 'GET', url: '/api/admin/roles', headers: authHeader });
    expect(rolesRes.statusCode).toBe(200);
    const roles = rolesRes.json() as { id: number; name: string }[];
    const devRole = roles.find((r) => r.name === '开发人员')!;
    const opsRole = roles.find((r) => r.name === '服务管理员')!;
    expect(devRole).toBeTruthy();
    expect(opsRole).toBeTruthy();

    // Create a developer user
    const createDev = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeader,
      payload: {
        username: 'dev1',
        displayName: '开发一',
        password: DEV_PASS,
        roleId: devRole.id,
        mustChangePassword: false,
      },
    });
    expect(createDev.statusCode).toBe(201);
    const devUserId = (createDev.json() as { id: number }).id;

    // Login as developer
    const devLogin = await login('dev1', DEV_PASS);
    expect(devLogin.statusCode).toBe(200);
    const devToken = (devLogin.json() as { token: string }).token;
    const devHeader = { authorization: `Bearer ${devToken}` };

    // Developer: can read repos & trigger review, cannot edit repos / edit providers / read logs / manage users
    expect((await app.inject({ method: 'GET', url: '/api/repos', headers: devHeader })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/repos/1/review', headers: devHeader })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/repos', headers: devHeader })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/providers', headers: devHeader })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/logs', headers: devHeader })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: devHeader })).statusCode).toBe(403);

    // Super admin promotes dev1 to super admin -> immediately gains all permissions
    const promote = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${devUserId}`,
      headers: authHeader,
      payload: { isSuperAdmin: true },
    });
    expect(promote.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/providers', headers: devHeader })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: devHeader })).statusCode).toBe(200);

    // Super admin disables dev1 -> session is revoked immediately
    const disable = await app.inject({
      method: 'PUT',
      url: `/api/admin/users/${devUserId}`,
      headers: authHeader,
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/repos', headers: devHeader })).statusCode).toBe(401);
    expect((await login('dev1', DEV_PASS)).statusCode).toBe(403);

    // Brute-force lockout after 5 failed attempts, and re-enabling clears lockout
    const createdOps = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeader,
      payload: {
        username: 'ops1',
        displayName: '运维一',
        password: OPS_PASS,
        roleId: opsRole.id,
        mustChangePassword: false,
      },
    });
    const opsId = (createdOps.json() as { id: number }).id;
    for (let i = 0; i < 5; i++) {
      expect((await login('ops1', 'WrongPass99')).statusCode).toBe(401);
    }
    expect((await login('ops1', OPS_PASS)).statusCode).toBe(429);

    // Disable then re-enable unlocks the account
    expect(
      (await app.inject({ method: 'PUT', url: `/api/admin/users/${opsId}`, headers: authHeader, payload: { status: 'disabled' } })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'PUT', url: `/api/admin/users/${opsId}`, headers: authHeader, payload: { status: 'active' } })).statusCode
    ).toBe(200);
    expect((await login('ops1', OPS_PASS)).statusCode).toBe(200);

    // Invalid id params return 400 and non-numeric audit-logs limit does not throw 500
    expect(
      (await app.inject({ method: 'PUT', url: '/api/admin/users/not-a-number', headers: authHeader, payload: { displayName: 'x' } })).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/admin/audit-logs?limit=abc', headers: authHeader })).statusCode
    ).toBe(200);
  });

  it('supports registration request -> notification -> approve & reject flows', async () => {
    const adminToken = await loginAdmin();
    const authHeader = { authorization: `Bearer ${adminToken}` };

    const roles = (
      await app.inject({ method: 'GET', url: '/api/admin/roles', headers: authHeader })
    ).json() as { id: number; name: string }[];
    const devRole = roles.find((r) => r.name === '开发人员')!;

    // Submit registration request
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'newdev',
        displayName: '新同学',
        email: 'newdev@example.com',
        password: DEV_PASS,
        reason: '加入核心研发组',
      },
    });
    expect(reg.statusCode).toBe(201);
    expect(notifiedRegs).toContain('newdev');
    const regId = (reg.json() as { id: number }).id;

    // Logging in before approval gives clear pending status (only when password matches)
    const pendingLogin = await login('newdev', DEV_PASS);
    expect(pendingLogin.statusCode).toBe(403);
    expect((pendingLogin.json() as { code: string }).code).toBe('REGISTRATION_PENDING');
    expect((await login('newdev', 'WrongPass123')).statusCode).toBe(401);

    // Approve with developer role
    const approved = await app.inject({
      method: 'POST',
      url: `/api/admin/registrations/${regId}/approve`,
      headers: authHeader,
      payload: { roleId: devRole.id },
    });
    expect(approved.statusCode).toBe(200);

    // Now login works and password change works
    const okLogin = await login('newdev', DEV_PASS);
    expect(okLogin.statusCode).toBe(200);
    const userToken = (okLogin.json() as { token: string }).token;
    const chPwd = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { currentPassword: DEV_PASS, password: NEW_PASS },
    });
    expect(chPwd.statusCode).toBe(200);
    expect((await login('newdev', NEW_PASS)).statusCode).toBe(200);

    // Reject flow
    const reg2 = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'outsider', displayName: '外部', password: DEV_PASS },
    });
    const reg2Id = (reg2.json() as { id: number }).id;
    const rej = await app.inject({
      method: 'POST',
      url: `/api/admin/registrations/${reg2Id}/reject`,
      headers: authHeader,
      payload: { reason: '非本项目成员' },
    });
    expect(rej.statusCode).toBe(200);
    const rejLogin = await login('outsider', DEV_PASS);
    expect(rejLogin.statusCode).toBe(403);
    expect((rejLogin.json() as { code: string }).code).toBe('REGISTRATION_REJECTED');
  });

  it('ignores spoofed X-Forwarded-For for registration rate limiting when trustProxy is disabled', async () => {
    const strictApp = Fastify();
    buildAuthRoutes(db, {
      loginRequired: true,
      dataDir: dir,
      maxRegistrationsPerHourPerIp: 2,
    }).register(strictApp);
    await strictApp.ready();
    try {
      for (let i = 1; i <= 2; i++) {
        const res = await strictApp.inject({
          method: 'POST',
          url: '/api/auth/register',
          headers: { 'x-forwarded-for': `10.0.0.${i}` },
          payload: { username: `spoofuser${i}`, displayName: 'u', password: DEV_PASS },
        });
        expect(res.statusCode).toBe(201);
      }
      const third = await strictApp.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-forwarded-for': '10.0.0.99' },
        payload: { username: 'spoofuser3', displayName: 'u', password: DEV_PASS },
      });
      expect(third.statusCode).toBe(429);
    } finally {
      await strictApp.close();
    }
  });

  it('can disable the guard explicitly (AUTH_REQUIRED=false)', async () => {
    const open = await buildApp(false);
    try {
      expect((await open.inject({ method: 'GET', url: '/api/repos' })).statusCode).toBe(200);
      expect((await open.inject({ method: 'POST', url: '/api/providers' })).statusCode).toBe(200);
    } finally {
      await open.close();
    }
  });
});
