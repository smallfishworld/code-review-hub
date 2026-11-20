import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { randomBytes } from 'node:crypto';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { buildNotificationRoutes } from './notificationRoutes.js';
import { matchesTrigger, parseTrigger } from './types.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let app: Fastify.FastifyInstance;
let credentials: CredentialService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crp-notif-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  app = Fastify();
  buildNotificationRoutes(db, credentials).register(app);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, payload: body as never });
const put = (url: string, body?: unknown) =>
  app.inject({ method: 'PUT', url, payload: body as never });

const SMTP_PASSWORD = randomBytes(10).toString('hex');

const emailBody = {
  type: 'email',
  name: 'ops-mail',
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  from: 'review@example.com',
  to: ['dev@example.com', 'qa@example.com'],
  username: 'review',
  password: SMTP_PASSWORD,
};

describe('notification channel API', () => {
  it('creates an email channel with masked password and encrypted storage', async () => {
    const res = await post('/api/notifications/channels', emailBody);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: number;
      type: string;
      config: { host: string; to: string[]; password: string; hasPassword: boolean };
    };
    expect(body.type).toBe('email');
    expect(body.config.host).toBe('smtp.example.com');
    expect(body.config.to).toEqual(['dev@example.com', 'qa@example.com']);
    expect(body.config.password).toBe('********');
    expect(body.config.hasPassword).toBe(true);
    expect(res.body).not.toContain(SMTP_PASSWORD);

    const row = db.prepare('SELECT ciphertext FROM credential').get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('utf8')).not.toContain(SMTP_PASSWORD);
    const credId = (
      db.prepare('SELECT credential_id FROM notification_channel').get() as {
        credential_id: number;
      }
    ).credential_id;
    expect(credentials.reveal(credId)).toBe(SMTP_PASSWORD);
  });

  it('validates email fields', async () => {
    expect((await post('/api/notifications/channels', { type: 'email', name: 'x' })).statusCode).toBe(400);
    expect(
      (await post('/api/notifications/channels', { ...emailBody, port: 0 })).statusCode
    ).toBe(400);
    expect(
      (await post('/api/notifications/channels', { ...emailBody, to: ['bad-address'] })).statusCode
    ).toBe(400);
    expect(
      (await post('/api/notifications/channels', { ...emailBody, to: [] })).statusCode
    ).toBe(400);
    expect(
      (await post('/api/notifications/channels', { ...emailBody, type: 'sms' })).statusCode
    ).toBe(400);
  });

  it('rejects duplicate names and preserves the password on update', async () => {
    await post('/api/notifications/channels', emailBody);
    expect((await post('/api/notifications/channels', emailBody)).statusCode).toBe(409);

    const id = (db.prepare('SELECT id FROM notification_channel').get() as { id: number }).id;
    const upd = await put(`/api/notifications/channels/${id}`, { to: ['new@example.com'] });
    expect(upd.statusCode).toBe(200);
    const body = upd.json() as { config: { to: string[]; hasPassword: boolean } };
    expect(body.config.to).toEqual(['new@example.com']);
    expect(body.config.hasPassword).toBe(true);

    const credId = (
      db.prepare('SELECT credential_id FROM notification_channel').get() as {
        credential_id: number;
      }
    ).credential_id;
    expect(credentials.reveal(credId)).toBe(SMTP_PASSWORD);
  });

  it('creates a chat channel, masks the webhook and headers, and keeps secrets encrypted', async () => {
    const res = await post('/api/notifications/channels', {
      type: 'chat',
      name: 'team-bot',
      webhookUrl: 'https://chat.example.com/hook?token=topsecret',
      headers: { 'X-Auth': 'header-secret' },
      template: '【代码评审】{{repo}} {{node}}',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: number;
      template: string;
      config: { webhookUrl: string; headers: Record<string, string>; hasCredential: boolean };
    };
    expect(body.config.webhookUrl).toBe('https://chat.example.com********');
    expect(body.config.headers['X-Auth']).toBe('********');
    expect(body.config.hasCredential).toBe(true);
    expect(body.template).toContain('{{repo}}');
    expect(res.body).not.toContain('topsecret');
    expect(res.body).not.toContain('header-secret');

    const row = db.prepare('SELECT ciphertext FROM credential').get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('utf8')).not.toContain('topsecret');
  });

  it('updates a chat channel, keeping the webhook when omitted', async () => {
    const created = await post('/api/notifications/channels', {
      type: 'chat',
      name: 'bot',
      webhookUrl: 'https://chat.example.com/hook',
    });
    const id = (created.json() as { id: number }).id;
    const upd = await put(`/api/notifications/channels/${id}`, {
      template: '{{summary}}',
    });
    expect(upd.statusCode).toBe(200);
    expect((upd.json() as { template: string }).template).toBe('{{summary}}');

    const { service } = buildNotificationRoutes(db, credentials);
    expect(service.chatConfig(id).webhookUrl).toBe('https://chat.example.com/hook');

    // replacing the webhook updates the secret
    await put(`/api/notifications/channels/${id}`, { webhookUrl: 'https://other.example.com/x' });
    expect(service.chatConfig(id).webhookUrl).toBe('https://other.example.com/x');
  });

  it('keeps a stored header when the console echoes the mask back', async () => {
    const created = await post('/api/notifications/channels', {
      type: 'chat',
      name: 'bot',
      webhookUrl: 'https://chat.example.com/hook',
      headers: { 'X-Auth': 'header-secret', 'X-Trace': 'trace-1' },
    });
    const id = (created.json() as { id: number }).id;
    const { service } = buildNotificationRoutes(db, credentials);

    // What the console sends after editing: masked values for untouched
    // headers, a new value for one, and a removed line for another.
    const upd = await put(`/api/notifications/channels/${id}`, {
      headers: { 'X-Auth': '********', 'X-Trace': 'trace-2' },
    });
    expect(upd.statusCode).toBe(200);
    expect(service.chatConfig(id).headers).toEqual({
      'X-Auth': 'header-secret',
      'X-Trace': 'trace-2',
    });

    // Clearing every line really clears the headers.
    await put(`/api/notifications/channels/${id}`, { headers: {} });
    expect(service.chatConfig(id).headers).toEqual({});
  });

  it('rejects an invalid chat webhook URL', async () => {
    expect(
      (
        await post('/api/notifications/channels', {
          type: 'chat',
          name: 'bot',
          webhookUrl: 'not-a-url',
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await post('/api/notifications/channels', {
          type: 'chat',
          name: 'bot',
        })
      ).statusCode
    ).toBe(400);
  });

  it('enables, disables and deletes channels', async () => {
    const created = await post('/api/notifications/channels', emailBody);
    const id = (created.json() as { id: number }).id;
    expect((created.json() as { enabled: boolean }).enabled).toBe(false);

    const enabled = await post(`/api/notifications/channels/${id}/enable`);
    expect((enabled.json() as { enabled: boolean }).enabled).toBe(true);
    const disabled = await post(`/api/notifications/channels/${id}/disable`);
    expect((disabled.json() as { enabled: boolean }).enabled).toBe(false);

    expect((await app.inject({ method: 'DELETE', url: `/api/notifications/channels/${id}` })).statusCode).toBe(204);
    expect((db.prepare('SELECT COUNT(*) AS n FROM credential').get() as { n: number }).n).toBe(0);
    expect((await app.inject({ method: 'GET', url: `/api/notifications/channels/${id}` })).statusCode).toBe(404);
  });

  it('reads and writes the global trigger rule', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/notifications/trigger' });
    expect((initial.json() as { trigger: string }).trigger).toBe('all');

    const set = await put('/api/notifications/trigger', { trigger: 'failed_only' });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { trigger: string }).trigger).toBe('failed_only');
    const reread = await app.inject({ method: 'GET', url: '/api/notifications/trigger' });
    expect((reread.json() as { trigger: string }).trigger).toBe('failed_only');

    expect((await put('/api/notifications/trigger', { trigger: 'sometimes' })).statusCode).toBe(400);
  });
});

describe('trigger rule matching', () => {
  it('filters by task status', () => {
    expect(matchesTrigger('all', 'succeeded')).toBe(true);
    expect(matchesTrigger('all', 'failed')).toBe(true);
    expect(matchesTrigger('failed_only', 'failed')).toBe(true);
    expect(matchesTrigger('failed_only', 'succeeded')).toBe(false);
    expect(matchesTrigger('success_only', 'succeeded')).toBe(true);
    expect(matchesTrigger('success_only', 'failed')).toBe(false);
  });

  it('parses unknown stored values as all', () => {
    expect(parseTrigger(null)).toBe('all');
    expect(parseTrigger('garbage')).toBe('all');
    expect(parseTrigger('success_only')).toBe('success_only');
  });
});
