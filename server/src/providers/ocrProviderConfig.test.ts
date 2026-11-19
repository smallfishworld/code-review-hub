import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import {
  buildOcrConfig,
  prepareOcrHome,
  resolveProvider,
  defaultProviderId,
} from './ocrProviderConfig.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let credentials: CredentialService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-ocrprov-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function addProvider(
  name: string,
  opts: { protocol?: string; key?: string; model?: string } = {}
): number {
  const credId = opts.key ? credentials.store(`provider:${name}`, 'llm', opts.key) : null;
  const info = db
    .prepare(
      `INSERT INTO provider (name, api_base, model, protocol, credential_id)
       VALUES (?, 'https://llm.example.com/v1', ?, ?, ?)`
    )
    .run(name, opts.model ?? 'model-a', opts.protocol ?? 'anthropic', credId);
  return Number(info.lastInsertRowid);
}

describe('ocr provider config bridge', () => {
  it('builds a custom_providers entry for a custom provider', () => {
    const cfg = buildOcrConfig({
      name: 'my-gateway',
      apiBase: 'https://gw.example.com/v1',
      model: 'm1',
      protocol: 'openai',
      apiKey: 'sk-1',
    });
    expect(cfg.provider).toBe('my-gateway');
    expect(cfg.custom_providers?.['my-gateway']).toEqual({
      url: 'https://gw.example.com/v1',
      model: 'm1',
      protocol: 'openai',
      api_key: 'sk-1',
    });
    expect(cfg.providers).toBeUndefined();
    // Report output language: ocr interpolates this into its review prompt
    // ("Always respond in <language>") — forces Chinese review comments.
    expect(cfg.language).toBe('中文（简体）');
  });

  it('builds a providers entry for the built-in anthropic provider', () => {
    const cfg = buildOcrConfig({
      name: 'anthropic',
      apiBase: 'https://api.anthropic.com',
      model: 'claude-sonnet',
      protocol: 'anthropic',
      apiKey: null,
    });
    expect(cfg.providers?.anthropic).toEqual({
      url: 'https://api.anthropic.com',
      model: 'claude-sonnet',
      protocol: 'anthropic',
    });
    expect(cfg.custom_providers).toBeUndefined();
  });

  it('resolves the default provider, falling back to the first row', () => {
    expect(resolveProvider(db, credentials)).toBeNull();
    const first = addProvider('first', { key: 'k1' });
    const second = addProvider('second', { key: 'k2' });

    const resolved = resolveProvider(db, credentials)!;
    expect(resolved.name).toBe('first');
    expect(resolved.apiKey).toBe('k1');

    db.prepare("INSERT INTO setting (key, value) VALUES ('default_provider_id', ?)").run(
      String(second)
    );
    expect(defaultProviderId(db)).toBe(second);
    expect(resolveProvider(db, credentials)!.name).toBe('second');
    expect(first).toBeGreaterThan(0);
  });

  it('writes an isolated ocr home with the provider config', () => {
    const prepared = prepareOcrHome(join(dir, 'data'), {
      name: 'gw',
      apiBase: 'https://gw/v1',
      model: 'm',
      protocol: 'anthropic',
      apiKey: 'secret',
    })!;
    expect(prepared.homeDir).toBe(join(dir, 'data', 'ocr-home'));
    expect(prepared.env.HOME).toBe(prepared.homeDir);
    expect(prepared.env.USERPROFILE).toBe(prepared.homeDir);

    const written = JSON.parse(
      readFileSync(join(prepared.homeDir, '.opencodereview', 'config.json'), 'utf8')
    ) as { provider: string; custom_providers: Record<string, { api_key: string }> };
    expect(written.provider).toBe('gw');
    expect(written.custom_providers.gw.api_key).toBe('secret');
  });

  it('returns null when no provider is configured', () => {
    expect(prepareOcrHome(join(dir, 'data'), null)).toBeNull();
  });
});
