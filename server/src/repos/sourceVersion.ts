import type Database from 'better-sqlite3';

export function repoSourceVersion(db: Database.Database, repoId: number): number | undefined {
  const row = db.prepare('SELECT source_version FROM repo WHERE id = ?').get(repoId) as
    | { source_version: number }
    | undefined;
  return row?.source_version;
}

/** Slot zero preserves the existing cache path, including after source replacement. */
export function workspaceKey(repoId: number, sourceVersion = 0, workspaceSlot = 0): string {
  const sourceKey = sourceVersion === 0 ? String(repoId) : `${repoId}-v${sourceVersion}`;
  return workspaceSlot === 0 ? sourceKey : `${sourceKey}-slot-${workspaceSlot}`;
}
