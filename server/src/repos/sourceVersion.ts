import type Database from 'better-sqlite3';

export function repoSourceVersion(db: Database.Database, repoId: number): number | undefined {
  const row = db.prepare('SELECT source_version FROM repo WHERE id = ?').get(repoId) as
    | { source_version: number }
    | undefined;
  return row?.source_version;
}

/** Existing caches use the bare repo ID. Each source replacement gets a fresh cache. */
export function workspaceKey(repoId: number, sourceVersion = 0): string {
  return sourceVersion === 0 ? String(repoId) : `${repoId}-v${sourceVersion}`;
}
