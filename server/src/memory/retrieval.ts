import type Database from 'better-sqlite3';
import type { MemoryEntry, MemoryStore } from './store.js';

interface AcceptedRisk {
  file: string | null;
  line: number | null;
  node: string;
}

export interface ReviewMemoryEntry extends MemoryEntry {
  acceptedRisk?: AcceptedRisk;
}

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
  ): ReviewMemoryEntry[] {
    const budget = opts.budgetTokens ?? 1500;
    const changedFiles = new Set(input.changedFiles.map(normalizePath));
    const acceptedRisks = this.acceptedRisks(repoId);
    const candidates = new Map<number, ReviewMemoryEntry>();
    const consider = (e: MemoryEntry): void => {
      if (e.status !== 'active') return;
      if (e.confidence < 0.3) return; // 污染防护：低置信度不召回
      if (candidates.has(e.id)) return;
      const risk = acceptedRisks.get(e.id);
      if (risk && !risk.sameSource) return;
      candidates.set(e.id, risk
        ? { ...e, acceptedRisk: { file: risk.file, line: risk.line, node: risk.node } }
        : e);
    };

    // 1) scope prefix match over changed files
    for (const entry of this.store.list(repoId, { status: 'active' })) {
      const risk = acceptedRisks.get(entry.id);
      if (risk?.file) {
        if (changedFiles.has(risk.file)) consider(entry);
        continue;
      }
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
    const matchesChangedFile = (entry: ReviewMemoryEntry) =>
      Number(entry.acceptedRisk?.file != null && changedFiles.has(entry.acceptedRisk.file));
    scored.sort((a, b) =>
      matchesChangedFile(b.entry) - matchesChangedFile(a.entry) || b.score - a.score
    );

    const picked: ReviewMemoryEntry[] = [];
    let used = 0;
    for (const s of scored) {
      const cost = estimateTokens(renderEntry(s.entry));
      if (used + cost > budget) continue;
      picked.push(s.entry);
      used += cost;
    }
    return picked;
  }

  private acceptedRisks(repoId: number): Map<number, AcceptedRisk & { sameSource: number }> {
    const rows = this.db.prepare(
      `SELECT f.memory_id AS memoryId, i.file, i.line, t.node,
              t.source_version = r.source_version AS sameSource
       FROM review_feedback f
       JOIN task t ON t.id = f.task_id
       JOIN repo r ON r.id = t.repo_id
       JOIN report_issue i ON i.id = f.issue_id
       WHERE t.repo_id = ? AND f.verdict = 'wont_fix' AND f.memory_id IS NOT NULL
       ORDER BY f.id`
    ).all(repoId) as (AcceptedRisk & { memoryId: number; sameSource: number })[];
    return new Map(rows.map(({ memoryId, file, ...risk }) => [
      memoryId, { ...risk, file: file ? normalizePath(file) : null },
    ]));
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
export function rankEntries<T extends MemoryEntry>(
  entries: T[],
  now: number
): { entry: T; score: number }[] {
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

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function formatAcceptedRiskOrigin(risk: AcceptedRisk): string {
  const origin = `原评审节点 ${risk.node}`;
  if (!risk.file) return origin;
  const location = risk.line === null ? risk.file : `${risk.file}:${risk.line}`;
  return `${origin} · ${location}`;
}

function renderEntry(e: ReviewMemoryEntry): string {
  const head = `- [${e.kind}] ${e.title}`;
  if (e.acceptedRisk) return `${head}（${formatAcceptedRiskOrigin(e.acceptedRisk)}）: ${e.body}`;
  return e.scope ? `${head}（范围 ${e.scope}）: ${e.body}` : `${head}: ${e.body}`;
}
