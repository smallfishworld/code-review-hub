import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { buildProviderRoutes } from './providerRoutes.js';
import type Database from 'better-sqlite3';

// Throwaway test API key, generated at runtime (never a committed literal).
const TEST_API_KEY = randomBytes(12).toString('hex');

let dir: string;
let db: Database.Database;
let app: Fastify.FastifyInstance;
let credentials: CredentialService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crp-prov-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  app = Fastify();
  // Force the direct-HTTP path: a developer machine with ocr on PATH would
  // otherwise spawn the real binary and never reach the stub server.
  buildProviderRoutes(db, credentials, { testOptions: { ocrBin: '' } }).register(app);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const create = (body: unknown) =>
  app.inject({ method: 'POST', url: '/api/providers', payload: body as never });

describe('provider API', () => {
  it('creates a provider and masks the API key in responses', async () => {
    const res = await create({
      name: 'openai',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: TEST_API_KEY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: number; apiKey: string; hasApiKey: boolean };
    expect(body.apiKey).toBe('********');
    expect(body.hasApiKey).toBe(true);
    expect(res.body).not.toContain(TEST_API_KEY);

    // stored encrypted: ciphertext column must not contain the plaintext
    const row = db.prepare('SELECT ciphertext FROM credential').get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('utf8')).not.toContain(TEST_API_KEY);
    // but decryptable server-side
    const id = (db.prepare('SELECT credential_id FROM provider').get() as { credential_id: number })
      .credential_id;
    expect(credentials.reveal(id)).toBe(TEST_API_KEY);
  });

  it('validates required fields and URL format', async () => {
    expect((await create({ name: 'x' })).statusCode).toBe(400);
    expect(
      (await create({ name: 'x', apiBase: 'not-a-url', model: 'm' })).statusCode
    ).toBe(400);
    expect(
      (await create({ name: 'x', apiBase: 'ftp://a/b', model: 'm' })).statusCode
    ).toBe(400);
  });

  it('rejects duplicate names and supports update without key change', async () => {
    await create({ name: 'p1', apiBase: 'https://a/v1', model: 'm1', apiKey: 'k1' });
    expect((await create({ name: 'p1', apiBase: 'https://b/v1', model: 'm2' })).statusCode).toBe(409);

    const id = (db.prepare('SELECT id FROM provider').get() as { id: number }).id;
    const upd = await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      payload: { model: 'm3' },
    });
    expect(upd.statusCode).toBe(200);
    const body = upd.json() as { model: string; hasApiKey: boolean };
    expect(body.model).toBe('m3');
    expect(body.hasApiKey).toBe(true); // key preserved
    const credId = (db.prepare('SELECT credential_id FROM provider').get() as { credential_id: number })
      .credential_id;
    expect(credentials.reveal(credId)).toBe('k1');
  });

  it('update with a new key replaces the stored secret', async () => {
    await create({ name: 'p1', apiBase: 'https://a/v1', model: 'm1', apiKey: 'old' });
    const id = (db.prepare('SELECT id FROM provider').get() as { id: number }).id;
    await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      payload: { apiKey: 'new' },
    });
    const credId = (db.prepare('SELECT credential_id FROM provider').get() as { credential_id: number })
      .credential_id;
    expect(credentials.reveal(credId)).toBe('new');
  });

  it('delete removes provider and its credential', async () => {
    await create({ name: 'p1', apiBase: 'https://a/v1', model: 'm1', apiKey: 'k' });
    const id = (db.prepare('SELECT id FROM provider').get() as { id: number }).id;
    const del = await app.inject({ method: 'DELETE', url: `/api/providers/${id}` });
    expect(del.statusCode).toBe(204);
    expect((db.prepare('SELECT COUNT(*) AS n FROM provider').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM credential').get() as { n: number }).n).toBe(0);
  });

  it('test endpoint reports success against a live stub', async () => {
    const server = await startStub(200, '{"data":[]}');
    try {
      const res = await create({
        name: 'p1',
        apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'm',
        apiKey: 'k',
      });
      const id = (res.json() as { id: number }).id;
      const test = await app.inject({ method: 'POST', url: `/api/providers/${id}/test` });
      expect(test.statusCode).toBe(200);
      expect((test.json() as { ok: boolean }).ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('test endpoint returns the concrete failure reason', async () => {
    const server = await startStub(401, '{"error":{"message":"invalid key"}}');
    try {
      const res = await create({
        name: 'p1',
        apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'm',
        apiKey: 'bad',
      });
      const id = (res.json() as { id: number }).id;
      const test = await app.inject({ method: 'POST', url: `/api/providers/${id}/test` });
      // A failed test is a diagnosis, not a transport error: the body carries
      // ok:false so the console can render it inline.
      expect(test.statusCode).toBe(200);
      const body = test.json() as { ok: boolean; message: string };
      expect(body.ok).toBe(false);
      expect(body.message).toContain('401');
      expect(body.message).toContain('invalid key');
      expect(body.message).toContain('API Key 无效');
    } finally {
      server.close();
    }
  });

  it('test endpoint reports a missing key instead of throwing', async () => {
    const res = await create({ name: 'p1', apiBase: 'https://a/v1', model: 'm' });
    const id = (res.json() as { id: number }).id;
    const test = await app.inject({ method: 'POST', url: `/api/providers/${id}/test` });
    expect(test.statusCode).toBe(200);
    const body = test.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('API Key');
  });

  it('test endpoint posts to the protocol chat endpoint, not /models', async () => {
    const seen: { url?: string; body?: string } = {};
    const server = createServer((req, res) => {
      seen.url = req.url;
      let body = '';
      req.on('data', (d: Buffer) => {
        body += d.toString();
      });
      req.on('end', () => {
        seen.body = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"msg_1","content":[]}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const res = await create({
        name: 'p1',
        apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'gpt-4o',
        apiKey: 'k',
        protocol: 'openai',
      });
      const id = (res.json() as { id: number }).id;
      const test = await app.inject({ method: 'POST', url: `/api/providers/${id}/test` });
      expect((test.json() as { ok: boolean }).ok).toBe(true);
      expect(seen.url).toBe('/v1/chat/completions');
      // the configured model must be part of the probe, so a wrong model name fails
      expect(JSON.parse(seen.body ?? '{}')).toMatchObject({ model: 'gpt-4o' });
    } finally {
      server.close();
    }
  });

  it('test endpoint uses the protocol auth scheme (anthropic sends x-api-key)', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    let url: string | undefined;
    const server = createServer((req, res) => {
      seen = req.headers;
      url = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_1","content":[]}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const res = await create({
        name: 'claude',
        apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'm',
        apiKey: 'k',
        protocol: 'anthropic',
      });
      const id = (res.json() as { id: number }).id;
      const test = await app.inject({ method: 'POST', url: `/api/providers/${id}/test` });
      expect(test.statusCode).toBe(200);
      expect(url).toBe('/v1/messages');
      expect(seen['x-api-key']).toBe('k');
      expect(seen.authorization).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('test endpoint reports bedrock as not probeable instead of failing', async () => {
    const res = await create({
      name: 'bedrock',
      apiBase: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      model: 'm',
      apiKey: 'k',
      protocol: 'anthropic-bedrock',
    });
    const id = (res.json() as { id: number }).id;
    const test = await app.inject({ method: 'POST', url: `/api/providers/${id}/test` });
    expect(test.statusCode).toBe(200);
    expect((test.json() as { message: string }).message).toContain('Bedrock');
  });
});

function startStub(status: number, body: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
