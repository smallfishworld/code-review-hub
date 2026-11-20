import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import type { LogService } from '../logs/logService.js';
import { OcrEngine } from './ocrEngine.js';
import type { ReviewEngine } from './types.js';

/**
 * Engine registry: instantiates adapter instances from DB rows and performs
 * the idempotent first-run bootstrap (a default ocr engine + global default
 * pointer), per openspec D3.
 */

export interface EngineRow {
  id: number;
  name: string;
  kind: 'ocr' | 'claude-code' | 'codex' | 'custom-http' | 'custom-script';
  config: string;
  credential_id: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export function rowToEngine(row: Record<string, unknown>): EngineRow {
  return {
    id: row.id as number,
    name: row.name as string,
    kind: row.kind as EngineRow['kind'],
    config: (row.config as string) ?? '{}',
    credential_id: (row.credential_id as number | null) ?? null,
    enabled: (row.enabled as number) ?? 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function getEngineRow(db: Database.Database, id: number): EngineRow | undefined {
  const row = db.prepare('SELECT * FROM engine WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEngine(row) : undefined;
}

export function defaultEngineId(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT value FROM setting WHERE key = 'default_engine_id'")
    .get() as { value: string } | undefined;
  const id = row?.value ? Number(row.value) : NaN;
  return Number.isInteger(id) ? id : null;
}

export function setDefaultEngine(db: Database.Database, id: number): void {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('default_engine_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(id));
}

export interface EngineBootstrapResult {
  created: boolean;
  engineId: number;
}

/**
 * Idempotent first-run bootstrap: when no engine record exists, insert the
 * default ocr engine and make it the global default. Existing behavior is
 * unchanged for setups created before engines existed (report shows
 * `ocr（历史）` for tasks with engine_id NULL).
 */
export function bootstrapEngines(db: Database.Database): EngineBootstrapResult {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM engine').get() as { n: number }).n;
  if (count > 0) return { created: false, engineId: 0 };
  const info = db
    .prepare(
      `INSERT INTO engine (name, kind, config, enabled) VALUES ('ocr', 'ocr', '{}', 1)`
    )
    .run();
  const engineId = Number(info.lastInsertRowid);
  setDefaultEngine(db, engineId);
  return { created: true, engineId };
}

export class EngineNotSupportedError extends Error {
  constructor(kind: string) {
    super(`引擎类型 ${kind} 的适配器尚未实现（当前仅支持 ocr）`);
  }
}

/** Instantiate the adapter for an engine row. Capabilities are code-level. */
export function createEngine(
  row: EngineRow,
  db: Database.Database,
  credentials: CredentialService,
  opts: { dataDir: string; logs?: LogService }
): ReviewEngine {
  if (row.kind !== 'ocr') throw new EngineNotSupportedError(row.kind);
  return new OcrEngine(row.id, row.name, db, credentials, {
    dataDir: opts.dataDir,
    logs: opts.logs,
  });
}
