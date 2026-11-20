import type Database from 'better-sqlite3';
import type { MemoryEntry, MemoryStore } from './store.js';

/**
 * Pre-review memory retrieval (design D6): scope prefix matching union FTS
 * (or LIKE fallback) over the change set collected by the engine's prepare(),
 * scored by confidence x recency x hits, truncated to a token budget.
 *
 * Token estimation is mixed-script: ASCII ~4 chars/token, CJK ~1.5
 * chars/token (a plain chars/4 estimate under-counts Chinese text by 6-8x,
 * which would blow the injection budget — reports are forced Chinese).
 */
export class MemoryRetrieval {
  constructor(
    private readonly store: MemoryStore,
    private readonly db: Database.Database
  ) {}

  retrieve(
    repoId: number,
    input: { changedFiles: string[]; identifiers: string[] },
    opts: { budgetTokens?: number; limit?: number } = {}
  ): MemoryEntry[] {
    const budget = opts.budgetTokens ?? 1500;
    const candidates = new Map<number, MemoryEntry>();
    const consider = (e: MemoryEntry): void => {
      if (e.status !== 'active') return;
      if (e.confidence < 0.3) return; // 污染防护：低置信度不召回
      if (!candidates.has(e.id)) candidates.set(e.id, e);
    };

    // 1) scope prefix match over changed files
    for (const entry of this.store.list(repoId, { status: 'active' })) {
      if (!entry.scope) {
        consider(entry); // 全仓库作用域
        continue;
      }
      const hit = input.changedFiles.some(
        (f) => f.startsWith(entry.scope!) || entry.scope!.startsWith(f + '/')
      );
      if (hit) consider(entry);
    }

    // 2) full-text match on identifiers / file names
    const terms = [...input.identifiers.slice(0, 40), ...input.changedFiles.slice(0, 20)]
      .map((t) => t.trim())
      .filter((t) => t.length >= 3);
    if (terms.length > 0) {
      const matched = this.store.ftsAvailable()
        ? this.ftsMatch(repoId, terms)
        : this.likeMatch(repoId, terms);
      for (const e of matched) consider(e);
    }

    // 3) score + budget truncation
    const scored = rankEntries([...candidates.values()], Date.now());
    scored.sort((a, b) => b.score - a.score);

    const picked: MemoryEntry[] = [];
    let used = 0;
    for (const s of scored) {
      const cost = estimateTokens(renderEntry(s.entry));
      if (used + cost > budget) continue;
      picked.push(s.entry);
      used += cost;
    }
    return picked;
  }

  /** FTS5 MATCH over title/body; each term quoted (FTS5 operator chars). */
  private ftsMatch(repoId: number, terms: string[]): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const term of terms) {
      const quoted = `"${term.replace(/"/g, '""')}"`;
      const rows = this.db
        .prepare(
          `SELECT memory_entry.* FROM memory_fts
           JOIN memory_entry ON memory_entry.id = memory_fts.rowid
           WHERE memory_fts MATCH ? AND memory_entry.repo_id = ? AND memory_entry.status = 'active'
           LIMIT 10`
        )
        .all(quoted, repoId) as Record<string, unknown>[];
      for (const row of rows) out.push(fromRow(row));
    }
    return out;
  }

  /** LIKE fallback when FTS5/trigram is unavailable. */
  private likeMatch(repoId: number, terms: string[]): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const term of terms) {
      const pattern = `%${term}%`;
      const rows = this.db
        .prepare(
          `SELECT * FROM memory_entry
           WHERE repo_id = ? AND status = 'active' AND (title LIKE ? OR body LIKE ?)
           LIMIT 10`
        )
        .all(repoId, pattern, pattern) as Record<string, unknown>[];
      for (const row of rows) out.push(fromRow(row));
    }
    return out;
  }
}

function fromRow(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as number,
    repoId: row.repo_id as number,
    kind: row.kind as MemoryEntry['kind'],
    scope: (row.scope as string | null) ?? null,
    title: row.title as string,
    body: row.body as string,
    fingerprint: null,
    confidence: row.confidence as number,
    hits: row.hits as number,
    feedbackCount: row.feedback_count as number,
    status: row.status as MemoryEntry['status'],
    sourceTaskId: null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: null,
  };
}

/** Exponential recency with a 90-day half-life (design D6). */
function recency(updatedAt: string, now: number): number {
  const ageMs = now - new Date(updatedAt).getTime();
  const days = Math.max(0, ageMs / 86_400_000);
  return Math.pow(0.5, days / 90);
}

/** Canonical ranking (confidence × recency × hits) — shared by injection and the MCP bridge. */
export function rankEntries(
  entries: MemoryEntry[],
  now: number
): { entry: MemoryEntry; score: number }[] {
  return entries.map((entry) => ({
    entry,
    score: entry.confidence * recency(entry.updatedAt, now) * Math.log2(2 + entry.hits),
  }));
}

/** Mixed-script token estimate: ASCII/4 + non-ASCII x1.5. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + Math.ceil(nonAscii * 1.5);
}

function renderEntry(e: MemoryEntry): string {
  const head = `- [${e.kind}] ${e.title}`;
  return e.scope ? `${head}（范围 ${e.scope}）: ${e.body}` : `${head}: ${e.body}`;
}
