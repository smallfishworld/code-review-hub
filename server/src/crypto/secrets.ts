import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Credential encryption: AES-256-GCM with a local keyfile.
 *
 * The keyfile is generated on first use (32 bytes random, O_EXCL create to
 * avoid clobbering, 0600 perms on POSIX). Ciphertext blobs carry their own
 * random IV + GCM auth tag, so the same plaintext encrypts differently
 * every time. Threat model: single-box intranet tool; the keyfile protects
 * against casual database-file leaks, not a full machine compromise.
 */

const KEYFILE_NAME = 'secret.key';

export class SecretStoreError extends Error {}

export class SecretStore {
  private key: Buffer;

  /**
   * @param dataDir directory holding the keyfile; created if missing.
   * @param keyfileName override for tests (isolated keyfiles).
   */
  constructor(dataDir: string, keyfileName: string = KEYFILE_NAME) {
    mkdirSync(dataDir, { recursive: true });
    const keyPath = join(dataDir, keyfileName);
    if (!existsSync(keyPath)) {
      // O_EXCL: fail rather than overwrite an existing keyfile.
      const fd = openSync(keyPath, 'wx');
      try {
        writeFileSync(fd, randomBytes(32));
      } finally {
        closeSync(fd);
      }
      if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) {
      throw new SecretStoreError(`secret keyfile ${keyPath} must be 32 bytes`);
    }
  }

  encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(payload: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.iv);
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}


/**
 * Simple bcrypt-free admin password hashing using scrypt (node builtin):
 * stored as `scrypt$N$salt$hash`. Not user-facing; strong enough for a
 * single-admin intranet tool without pulling a native bcrypt dep.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const actual = scryptSync(password, salt, expected.length, { N, r: 8, p: 1 });
  // constant-time compare
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** Redact a credential for API responses: never echo plaintext back. */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return '********';
}

/** Remove the keyfile (tests only). */
export function destroyKeyfile(dataDir: string, keyfileName: string = KEYFILE_NAME): void {
  const p = join(dataDir, keyfileName);
  if (existsSync(p)) unlinkSync(p);
}
