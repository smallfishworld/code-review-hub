import type Database from 'better-sqlite3';
import { SecretStore } from './secrets.js';

/**
 * Database-backed credential storage. Secrets are encrypted via SecretStore
 * (AES-256-GCM with a local keyfile); rows store ciphertext/iv/authTag.
 * Reads never leave the server process: API layers call maskedCredential()
 * for responses.
 */
export class CredentialService {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretStore
  ) {}

  /** Store a secret; returns the credential row id. */
  store(label: string, kind: string, plaintext: string): number {
    const { ciphertext, iv, authTag } = this.secrets.encrypt(plaintext);
    const info = this.db
      .prepare('INSERT INTO credential (label, kind, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?, ?)')
      .run(label, kind, ciphertext, iv, authTag);
    return Number(info.lastInsertRowid);
  }

  /** Replace the secret of an existing credential row (edit-in-place). */
  update(id: number, plaintext: string): void {
    const { ciphertext, iv, authTag } = this.secrets.encrypt(plaintext);
    this.db
      .prepare('UPDATE credential SET ciphertext = ?, iv = ?, auth_tag = ? WHERE id = ?')
      .run(ciphertext, iv, authTag, id);
  }

  /** Retrieve the plaintext (server-internal use only). */
  reveal(id: number): string | null {
    const row = this.db
      .prepare('SELECT ciphertext, iv, auth_tag FROM credential WHERE id = ?')
      .get(id) as { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer } | undefined;
    if (!row) return null;
    return this.secrets.decrypt({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
    });
  }

  /** Safe shape for API responses: id/label/kind only, never plaintext. */
  maskedCredential(row: { id: number; label: string; kind: string }): {
    id: number;
    label: string;
    kind: string;
    secret: string;
  } {
    return { ...row, secret: '********' };
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM credential WHERE id = ?').run(id);
  }
}
