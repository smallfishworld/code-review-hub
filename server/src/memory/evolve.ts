import type Database from 'better-sqlite3';
import { MemoryStore } from './store.js';

/**
 * Memory evolution (project-memory spec / design D6): archival scan runs
 * opportunistically before each retrieval (O(repo entries), no background
 * job); compaction merges duplicates and rewrites the markdown projection
 * every 20 completed reviews per repo.
 */

const ARCHIVE_DAYS = 90;
const ARCHIVE_CONFIDENCE_MAX = 0.3;
const COMPACTION_EVERY = 20;

/** Archive stale entries: >90d unused and confidence below threshold. */
export function runArchivalScan(store: MemoryStore, repoId: number): number {
  const entries = store.list(repoId, { status: 'active' });
  const now = Date.now();
  let archived = 0;
  for (const e of entries) {
    if (e.confidence >= ARCHIVE_CONFIDENCE_MAX) continue;
    const last = e.lastUsedAt ?? e.updatedAt;
    const days = (now - new Date(last).getTime()) / 86_400_000;
    if (Number.isFinite(days) && days > ARCHIVE_DAYS) {
      store.update(e.id, { status: 'archived' });
      archived++;
    }
  }
  return archived;
}

export interface CompactionResult {
  triggered: boolean;
  merged: number;
}

/** Merge near-duplicate entries (same kind + normalized title). */
export function runCompaction(
  db: Database.Database,
  store: MemoryStore,
  repoId: number
): CompactionResult {
  const reviews = reviewCount(db, repoId);
  const triggered = reviews > 0 && reviews % COMPACTION_EVERY === 0;
  if (!triggered) return { triggered: false, merged: 0 };

  const rows = db
    .prepare(`SELECT id, kind, title FROM memory_entry WHERE repo_id = ? ORDER BY kind, id`)
    .all(repoId) as unknown as { id: number; kind: MemoryEntryLite['kind']; title: string }[];
  const seen = new Map<string, number>();
  let merged = 0;
  for (const r of rows) {
    const key = normKey(r.kind, r.title);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, r.id);
      continue;
    }
    // 重复条目：并入第一条（置信度取较高者），删除后来者
    const a = store.get(first);
    const b = store.get(r.id);
    if (a && b) {
      store.update(first, { confidence: Math.max(a.confidence, b.confidence) });
      store.delete(r.id);
      merged++;
    }
  }
  store.syncAllMarkdown(repoId);
  return { triggered: true, merged };
}

interface MemoryEntryLite {
  kind: 'architecture' | 'convention' | 'pitfall' | 'suppression' | 'history' | 'glossary';
}

function normKey(kind: string, title: string): string {
  const t = title.replace(/\s+/g, '').toLowerCase();
  return kind + '|' + t;
}

function reviewCount(db: Database.Database, repoId: number): number {
  const key = 'memory_review_count_' + String(repoId);
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) || 0 : 0;
}

/** Increment the completed-review counter (call on task success). */
export function bumpReviewCount(db: Database.Database, repoId: number): number {
  const key = 'memory_review_count_' + String(repoId);
  const next = reviewCount(db, repoId) + 1;
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(next));
  return next;
}
