import type Database from 'better-sqlite3';

/**
 * Repo-level provider pool: the ordered list of LLM providers a repository's
 * reviews may use. A single member behaves exactly like the old single
 * `repo.provider_id` override; several members let concurrent reviews spread
 * across models.
 *
 * Assignment happens once, at enqueue time, and is persisted on the task
 * (`task.provider_id` + `task.provider_label`) so a review keeps its model
 * across restarts and retries, and reports stay attributable afterwards.
 */

export interface ProviderPoolEntry {
  providerId: number;
  /** Snapshot used by history display: "<name> · <model>". */
  label: string;
}

/** The repo's pool ordered by position (primary first); empty = inherit global. */
export function repoProviderPool(db: Database.Database, repoId: number): ProviderPoolEntry[] {
  return (
    db
      .prepare(
        `SELECT p.id AS provider_id, p.name, p.model
         FROM repo_provider rp JOIN provider p ON p.id = rp.provider_id
         WHERE rp.repo_id = ?
         ORDER BY rp.position, p.id`
      )
      .all(repoId) as { provider_id: number; name: string; model: string }[]
  ).map((row) => ({ providerId: row.provider_id, label: `${row.name} · ${row.model}` }));
}

/** Replace a repo's pool in one shot (order = array order). */
export function setRepoProviderPool(
  db: Database.Database,
  repoId: number,
  providerIds: number[]
): void {
  db.prepare('DELETE FROM repo_provider WHERE repo_id = ?').run(repoId);
  const insert = db.prepare(
    'INSERT INTO repo_provider (repo_id, provider_id, position) VALUES (?, ?, ?)'
  );
  providerIds.forEach((providerId, position) => insert.run(repoId, providerId, position));
}

/**
 * Choose the pool member with the fewest active (queued/running) tasks of
 * this repo — the load-balancing rule. Ties resolve by pool order, so the
 * primary model starts first and the spread stays deterministic.
 *
 * Returns null when the repo has no pool (callers then inherit the global
 * default provider, matching the pre-pool behaviour).
 */
export function pickProviderForTask(
  db: Database.Database,
  repoId: number,
  pool: ProviderPoolEntry[] = repoProviderPool(db, repoId)
): ProviderPoolEntry | null {
  if (pool.length === 0) return null;
  const load = new Map<number, number>();
  const rows = db
    .prepare(
      `SELECT provider_id, COUNT(*) AS n FROM task
       WHERE repo_id = ? AND status IN ('queued','running') AND provider_id IS NOT NULL
       GROUP BY provider_id`
    )
    .all(repoId) as { provider_id: number; n: number }[];
  for (const row of rows) load.set(row.provider_id, row.n);
  let best = pool[0];
  for (const entry of pool) {
    if ((load.get(entry.providerId) ?? 0) < (load.get(best.providerId) ?? 0)) best = entry;
  }
  return best;
}

/**
 * Label for a provider id, current as of "now" (name/model may since have
 * changed — history keeps the snapshot stored on the task instead).
 */
export function providerLabel(db: Database.Database, providerId: number): string | null {
  const row = db.prepare('SELECT name, model FROM provider WHERE id = ?').get(providerId) as
    | { name: string; model: string }
    | undefined;
  return row ? `${row.name} · ${row.model}` : null;
}