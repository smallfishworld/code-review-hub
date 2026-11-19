import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, hashPassword, verifyPassword, maskSecret } from './secrets.js';
import { CredentialService } from './credentialService.js';
import { openDatabase } from '../db/database.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-sec-'));
  db = openDatabase({ dataDir: join(dir, 'data') });
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SecretStore', () => {
  it('roundtrips utf8 plaintext including Chinese and symbols', () => {
    const s = new SecretStore(join(dir, 'keys'));
    const payload = s.encrypt('p@ss中文!#$% symbols');
    expect(s.decrypt(payload)).toBe('p@ss中文!#$% symbols');
  });

  it('stores ciphertext, not plaintext (keyfile + db never hold raw secret)', () => {
    const keyDir = join(dir, 'keys');
    const s = new SecretStore(keyDir);
    const payload = s.encrypt('top-secret-value');
    expect(payload.ciphertext.toString('utf8')).not.toContain('top-secret-value');
    const raw = readFileSync(join(keyDir, 'secret.key'));
    expect(raw.toString('utf8')).not.toContain('top-secret-value');
  });

  it('same plaintext encrypts to different ciphertexts (random IV)', () => {
    const s = new SecretStore(join(dir, 'keys'));
    const a = s.encrypt('same');
    const b = s.encrypt('same');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('creates the keyfile exactly once and reuses it', () => {
    const keyDir = join(dir, 'keys');
    const s1 = new SecretStore(keyDir);
    const p1 = s1.encrypt('x');
    const s2 = new SecretStore(keyDir);
    expect(s2.decrypt(p1)).toBe('x');
  });

  it('rejects a corrupted keyfile', () => {
    const keyDir = join(dir, 'keys');
    new SecretStore(keyDir); // create
    // truncate the keyfile to simulate corruption
    writeFileSync(join(keyDir, 'secret.key'), Buffer.alloc(8));
    expect(() => new SecretStore(keyDir)).toThrow(/32 bytes/);
  });

  it('decryption with a wrong key fails (auth tag mismatch)', () => {
    const keyDir = join(dir, 'keys');
    const s1 = new SecretStore(keyDir, 'key-a.key');
    const payload = s1.encrypt('x');
    const s2 = new SecretStore(keyDir, 'key-b.key');
    expect(() => s2.decrypt(payload)).toThrow();
  });
});

describe('CredentialService (DB-backed)', () => {
  it('stores encrypted and reveals internally, never leaks plaintext in masked output', () => {
    const secrets = new SecretStore(join(dir, 'keys'));
    const svc = new CredentialService(db, secrets);
    const id = svc.store('repo-a svn', 'svn', 's3cret中文');
    expect(svc.reveal(id)).toBe('s3cret中文');
    const masked = svc.maskedCredential({ id, label: 'repo-a svn', kind: 'svn' });
    expect(JSON.stringify(masked)).not.toContain('s3cret');
    expect(masked.secret).toBe('********');
  });

  it('persists ciphertext in db, plaintext nowhere on disk', () => {
    const secrets = new SecretStore(join(dir, 'keys'));
    const svc = new CredentialService(db, secrets);
    const id = svc.store('test', 'git', 'hunter2');
    const row = db
      .prepare('SELECT * FROM credential WHERE id = ?')
      .get(id) as Record<string, Buffer>;
    expect(row.ciphertext.toString('utf8')).not.toContain('hunter2');
    // reopen the db (restart simulation) and reveal again with a fresh service
    db.close();
    db = openDatabase({ dataDir: join(dir, 'data') });
    const svc2 = new CredentialService(db, secrets);
    expect(svc2.reveal(id)).toBe('hunter2');
  });

  it('update replaces the secret', () => {
    const secrets = new SecretStore(join(dir, 'keys'));
    const svc = new CredentialService(db, secrets);
    const id = svc.store('t', 'svn', 'old');
    svc.update(id, 'new');
    expect(svc.reveal(id)).toBe('new');
  });

  it('delete removes the row', () => {
    const secrets = new SecretStore(join(dir, 'keys'));
    const svc = new CredentialService(db, secrets);
    const id = svc.store('t', 'svn', 'x');
    svc.delete(id);
    expect(svc.reveal(id)).toBeNull();
  });
});

describe('admin password hashing', () => {
  it('hashes and verifies, salted per call', () => {
    const h1 = hashPassword('admin-pass');
    const h2 = hashPassword('admin-pass');
    expect(h1).not.toBe(h2);
    expect(verifyPassword('admin-pass', h1)).toBe(true);
    expect(verifyPassword('wrong', h1)).toBe(false);
  });
  it('rejects malformed stored values', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('maskSecret', () => {
  it('masks defined values and undefined stays undefined', () => {
    expect(maskSecret('real-secret')).toBe('********');
    expect(maskSecret(undefined)).toBeUndefined();
  });
});
