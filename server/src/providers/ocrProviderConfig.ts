import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoProviderPool } from './pool.js';

/**
 * Bridges the platform's Provider configuration into the `ocr` CLI.
 *
 * ocr resolves its LLM endpoint from `~/.opencodereview/config.json` (or the
 * OCR_LLM_* environment variables). Because the platform must not depend on
 * whatever the operator happens to have configured globally, each review runs
 * with an isolated HOME whose `.opencodereview/config.json` is generated from
 * the selected provider row. Custom providers use ocr's `custom_providers`
 * section; the built-in `anthropic` provider uses `providers.anthropic`.
 */

export const PROTOCOLS = [
  'anthropic',
  'anthropic-bedrock',
  'openai',
  'openai-responses',
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

/** ocr's built-in provider names (configured under `providers.<name>`). */
const BUILTIN_PROVIDERS = new Set(['anthropic']);

export interface OcrProviderSettings {
  name: string;
  apiBase: string;
  model: string;
  protocol: Protocol;
  apiKey: string | null;
}

export interface OcrConfigFile {
  provider?: string;
  /** ocr appends `"\n\nAlways respond in <language>"` to the review prompt. */
  language?: string;
  providers?: Record<string, Record<string, unknown>>;
  custom_providers?: Record<string, Record<string, unknown>>;
}

/**
 * Report output language forced into every generated ocr config. ocr's own
 * prompts are English, so without this the review comments come back in
 * English; the value is interpolated verbatim into "Always respond in <x>".
 */
export const OCR_REPORT_LANGUAGE = '中文（简体）';

/** Build the ocr config.json content for one provider. */
export function buildOcrConfig(settings: OcrProviderSettings): OcrConfigFile {
  const entry: Record<string, unknown> = {
    url: settings.apiBase,
    model: settings.model,
    protocol: settings.protocol,
  };
  if (settings.apiKey) entry.api_key = settings.apiKey;
  const config: OcrConfigFile = { language: OCR_REPORT_LANGUAGE, provider: settings.name };
  if (BUILTIN_PROVIDERS.has(settings.name)) {
    config.providers = { [settings.name]: entry };
  } else {
    config.custom_providers = { [settings.name]: entry };
  }
  return config;
}

/** Read the default provider id from settings (null when none chosen). */
export function defaultProviderId(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT value FROM setting WHERE key = 'default_provider_id'")
    .get() as { value: string } | undefined;
  const id = row?.value ? Number(row.value) : NaN;
  return Number.isInteger(id) ? id : null;
}

/** Resolve the provider used for reviews: the default, else the first row. */
export function resolveProvider(
  db: Database.Database,
  credentials: CredentialService,
  providerId?: number
): OcrProviderSettings | null {
  const preferred = providerId ?? defaultProviderId(db);
  const row = (
    preferred !== null
      ? db.prepare('SELECT * FROM provider WHERE id = ?').get(preferred)
      : db.prepare('SELECT * FROM provider ORDER BY id LIMIT 1').get()
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  const protocol = PROTOCOLS.includes(row.protocol as Protocol)
    ? (row.protocol as Protocol)
    : 'anthropic';
  return {
    name: row.name as string,
    apiBase: row.api_base as string,
    model: row.model as string,
    protocol,
    apiKey: row.credential_id
      ? credentials.reveal(row.credential_id as number)
      : null,
  };
}

/** Resolve the repository's default model, or inherit the global Provider. */
export function resolveRepositoryProvider(
  db: Database.Database, credentials: CredentialService, repoId: number
): OcrProviderSettings | null {
  const primary = repoProviderPool(db, repoId)[0];
  if (primary) {
    const fromPool = resolveProvider(db, credentials, primary.providerId);
    if (fromPool) return fromPool;
  }
  return resolveProvider(db, credentials);
}

/**
 * Resolve the provider a task actually runs with, in priority order:
 *
 * 1. `task.provider_id` — assigned from the repo's pool at enqueue time by
 *    the queue (load-balanced across concurrent reviews of one repo);
 * 2. the repo pool's primary member — for tasks queued before the pool was
 *    configured (provider_id NULL) on a repo that has one;
 * 3. the global default provider.
 *
 * A deleted provider drops out of steps 1-2 (resolveProvider returns null for
 * an unknown id) and the call falls through to the next step, so deleting a
 * model degrades rather than fails.
 */
export function resolveTaskProvider(
  db: Database.Database, credentials: CredentialService, task: { providerId?: number; repoId: number }
): OcrProviderSettings | null {
  if (task.providerId !== undefined) {
    const bound = resolveProvider(db, credentials, task.providerId);
    if (bound) return bound;
  }
  return resolveRepositoryProvider(db, credentials, task.repoId);
}

/**
 * Write the isolated ocr home for a provider and return the environment
 * overrides that point ocr at it. Returns null when no provider is configured
 * (ocr then falls back to its own defaults).
 *
 * `homeDir` defaults to `<dataDir>/ocr-home`; the connectivity test passes a
 * throwaway directory so it cannot clobber a review that is running.
 */
export function prepareOcrHome(
  dataDir: string,
  settings: OcrProviderSettings | null,
  homeDir: string = join(dataDir, 'ocr-home')
): { homeDir: string; env: Record<string, string> } | null {
  if (!settings) return null;
  const configDir = join(homeDir, '.opencodereview');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify(buildOcrConfig(settings), null, 2),
    'utf8'
  );
  prepareOcrHomeSvnConfig(homeDir);
  return {
    homeDir,
    env: {
      // Go's os.UserHomeDir() reads USERPROFILE on Windows and HOME on POSIX.
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
  };
}

/**
 * svn resolves its config/auth directory from $HOME when HOME is set — on
 * Windows that is `$HOME\AppData\Roaming\Subversion`, NOT the real %APPDATA%
 * (verified empirically: with HOME redirected, ocr's internal svn hung
 * forever on an auth prompt because the redirected home had an empty auth
 * store). Every svn call ocr itself makes runs under this redirected HOME,
 * so the ocr home needs its own Subversion config:
 *
 * - `servers` with trust-server-cert-failures so an intranet https server
 *   (self-signed / hostname-mismatch certs) does not trigger an interactive
 *   "accept certificate?" prompt that would hang the review forever;
 * - credentials are seeded into its auth store by the workspace init /
 *   runner's cacheAuth svn calls run with the SAME env (see
 *   ocrHomeSvnDir) — the seed writes wincrypt/DPAPI-encrypted secrets that
 *   the redirected svn can read back.
 */
export function prepareOcrHomeSvnConfig(homeDir: string): void {
  const svnDir = ocrHomeSvnDir(homeDir);
  mkdirSync(svnDir, { recursive: true });
  writeFileSync(
    join(svnDir, 'servers'),
    [
      '# Generated by the code review platform: ocr invokes svn itself without',
      '# auth/trust flags under this HOME; without this, an untrusted intranet',
      '# https certificate turns into an interactive prompt that hangs the run.',
      '[global]',
      'trust-server-cert-failures = unknown-ca,cn-mismatch,expired,not-yet-valid,other',
      '',
    ].join('\n'),
    'utf8'
  );
}

/**
 * Where svn keeps config/auth when $HOME is redirected to the ocr home:
 * Windows builds `%HOME%\AppData\Roaming\Subversion`, POSIX `$HOME/.subversion`.
 * The credential-seeding svn calls (cacheAuth) must run with the ocr HOME env
 * so they write into THIS store — the one ocr's own svn calls will read.
 */
export function ocrHomeSvnDir(homeDir: string): string {
  return process.platform === 'win32'
    ? join(homeDir, 'AppData', 'Roaming', 'Subversion')
    : join(homeDir, '.subversion');
}
