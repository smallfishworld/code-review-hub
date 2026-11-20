import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project memory store (openspec project-memory spec / design D6).
 *
 * SQLite is the source of truth; markdown under
 * `<DATA_DIR>/memory/<repo-id>/` is a projection humans can read and edit.
 * `reloadFromMarkdown()` re-imports edited files (matching by the id marker
 * in a leading HTML comment; unmarked sections become new entries).
 */

export type MemoryKind =
  | 'architecture'
  | 'convention'
  | 'pitfall'
  | 'suppression'
  | 'history'
  | 'glossary';

export type MemoryStatus = 'active' | 'archived' | 'rejected';

export interface MemoryEntry {
  id: number;
  repoId: number;
  kind: MemoryKind;
  scope: string | null;
  title: string;
  body: string;
  /** Suppression fingerprint (file prefix + issue feature hash); others NULL. */
  fingerprint: string | null;
  confidence: number;
  hits: number;
  /** Human confirmations via the feedback loop (independent of hits). */
  feedbackCount: number;
  status: MemoryStatus;
  sourceTaskId: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface MemoryInput {
  repoId: number;
  kind: MemoryKind;
  scope?: string | null;
  title: string;
  body: string;
  fingerprint?: string | null;
  confidence?: number;
  status?: MemoryStatus;
  sourceTaskId?: number | null;
}

/** markdown 文件名（按类型组织）。 */
const KIND_FILES: Record<MemoryKind, string> = {
  architecture: 'architecture.md',
  convention: 'conventions.md',
  pitfall: 'pitfalls.md',
  suppression: 'suppressions.md',
  history: 'history.md',
  glossary: 'glossary.md',
};

export function memoryDir(dataDir: string, repoId: number): string {
  return join(dataDir, 'memory', String(repoId));
}

export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

const KINDS = Object.keys(KIND_FILES) as MemoryKind[];

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as number,
    repoId: row.repo_id as number,
    kind: row.kind as MemoryKind,
    scope: (row.scope as string | null) ?? null,
    title: row.title as string,
    body: row.body as string,
    fingerprint: (row.fingerprint as string | null) ?? null,
    confidence: row.confidence as number,
    hits: row.hits as number,
    feedbackCount: row.feedback_count as number,
    status: row.status as MemoryStatus,
    sourceTaskId: (row.source_task_id as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

export class MemoryStore {
  constructor(
    private readonly db: Database.Database,
    private readonly dataDir: string
  ) {}

  /** FTS5 available? (v9 migration probes; LIKE fallback otherwise) */
  ftsAvailable(): boolean {
    const row = this.db
      .prepare("SELECT value FROM setting WHERE key = 'memory_fts_available'")
      .get() as { value: string } | undefined;
    return row?.value === '1';
  }

  list(repoId: number, opts: { kind?: MemoryKind; status?: MemoryStatus | 'all' } = {}): MemoryEntry[] {
    // 固定 SQL 变体（无动态 WHERE 拼接）。
    if (opts.kind && opts.status && opts.status !== 'all') {
      return this.query(
        'SELECT * FROM memory_entry WHERE repo_id = ? AND kind = ? AND status = ? ORDER BY kind, id',
        [repoId, opts.kind, opts.status]
      );
    }
    if (opts.kind) {
      return this.query(
        'SELECT * FROM memory_entry WHERE repo_id = ? AND kind = ? ORDER BY kind, id',
        [repoId, opts.kind]
      );
    }
    if (opts.status && opts.status !== 'all') {
      return this.query(
        'SELECT * FROM memory_entry WHERE repo_id = ? AND status = ? ORDER BY kind, id',
        [repoId, opts.status]
      );
    }
    return this.query('SELECT * FROM memory_entry WHERE repo_id = ? ORDER BY kind, id', [repoId]);
  }

  private query(sql: string, params: (string | number)[]): MemoryEntry[] {
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  get(id: number): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM memory_entry WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  create(input: MemoryInput): MemoryEntry {
    validateKind(input.kind);
    if (!input.title?.trim()) throw new MemoryError('标题不能为空');
    if (!input.body?.trim()) throw new MemoryError('正文不能为空');
    const confidence = clampConfidence(input.confidence ?? 0.5);
    if (input.kind === 'suppression' && !input.fingerprint) {
      throw new MemoryError('suppression 记忆必须包含误报指纹');
    }
    const info = this.db
      .prepare(
        `INSERT INTO memory_entry
           (repo_id, kind, scope, title, body, fingerprint, confidence, feedback_count, status, source_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.repoId,
        input.kind,
        input.scope ?? null,
        input.title.trim(),
        input.body.trim(),
        input.fingerprint ?? null,
        confidence,
        0,
        input.status ?? 'active',
        input.sourceTaskId ?? null
      );
    const entry = this.get(Number(info.lastInsertRowid))!;
    this.syncMarkdownFile(entry.repoId, entry.kind);
    return entry;
  }

  update(
    id: number,
    patch: Partial<
      Pick<MemoryInput, 'kind' | 'scope' | 'title' | 'body' | 'confidence' | 'status' | 'fingerprint'>
    >
  ): MemoryEntry {
    const current = this.get(id);
    if (!current) throw new MemoryError('记忆条目不存在', 404);
    const kind = patch.kind ?? current.kind;
    validateKind(kind);
    this.db
      .prepare(
        `UPDATE memory_entry SET kind = ?, scope = ?, title = ?, body = ?, fingerprint = ?,
           confidence = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(
        kind,
        patch.scope !== undefined ? patch.scope : current.scope,
        (patch.title ?? current.title).trim() || current.title,
        (patch.body ?? current.body).trim() || current.body,
        patch.fingerprint !== undefined ? patch.fingerprint : current.fingerprint,
        patch.confidence !== undefined ? clampConfidence(patch.confidence) : current.confidence,
        patch.status ?? current.status,
        id
      );
    // kind 可能变化：新旧两个 markdown 文件都要同步
    this.syncMarkdownFile(current.repoId, current.kind);
    this.syncMarkdownFile(current.repoId, kind);
    return this.get(id)!;
  }

  delete(id: number): void {
    const current = this.get(id);
    if (!current) throw new MemoryError('记忆条目不存在', 404);
    this.db.prepare('DELETE FROM memory_entry WHERE id = ?').run(id);
    this.syncMarkdownFile(current.repoId, current.kind);
  }

  /** Retrieval bookkeeping: count a hit. */
  markUsed(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE memory_entry
       SET hits = hits + 1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    tx();
  }

  /** Find by (repo, kind, title) — the markdown reload match key. */
  findByTitle(repoId: number, kind: MemoryKind, title: string): MemoryEntry | null {
    const row = this.db
      .prepare('SELECT id FROM memory_entry WHERE repo_id = ? AND kind = ? AND title = ? ORDER BY id LIMIT 1')
      .get(repoId, kind, title) as { id: number } | undefined;
    return row ? this.get(row.id) : null;
  }

  // --- markdown projection ----------------------------------------------------

  /** Write one kind's markdown file from the DB rows (projection). */
  private syncMarkdownFile(repoId: number, kind: MemoryKind): void {
    const dir = memoryDir(this.dataDir, repoId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, KIND_FILES[kind]);
    const entries = this.list(repoId, { kind, status: 'all' });
    if (entries.length === 0) {
      if (existsSync(file)) rmSync(file);
      return;
    }
    const header = `# ${kind} — repo ${repoId}`;
    const parts: string[] = [header, ''];
    for (const e of entries) {
      parts.push(`## ${e.title}`, '', e.body, '');
    }
    writeFileSync(file, parts.join('\n'), 'utf8');
  }

  /** Rewrite every kind's markdown (compaction / profile refresh). */
  syncAllMarkdown(repoId: number): void {
    for (const kind of KINDS) this.syncMarkdownFile(repoId, kind);
  }

  /**
   * Re-import markdown edited by hand. Sections match by (repo, kind, title):
   * edited sections update the row, new titles become new entries. SQLite
   * stays the source of truth for scope/status/confidence; files are
   * rewritten afterwards so titles stay canonical.
   */
  reloadFromMarkdown(repoId: number): { updated: number; created: number } {
    const dir = memoryDir(this.dataDir, repoId);
    let updated = 0;
    let created = 0;
    for (const [kind, fileName] of Object.entries(KIND_FILES) as [MemoryKind, string][]) {
      const file = join(dir, fileName);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const section of splitSections(text)) {
        const title = section.title.trim();
        const body = section.body.trim();
        if (!title || !body) continue;
        const existing = this.findByTitle(repoId, kind, title);
        if (existing) {
          this.update(existing.id, { title, body, kind });
          updated++;
        } else {
          this.create({ repoId, kind, title, body, confidence: 0.5 });
          created++;
        }
      }
    }
    this.syncAllMarkdown(repoId);
    return { updated, created };
  }
}

function validateKind(kind: MemoryKind): void {
  if (!KINDS.includes(kind)) {
    throw new MemoryError('记忆类型无效（必须是六类记忆之一）');
  }
}

function clampConfidence(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(0.99, Math.max(0.01, v));
}

interface MarkdownSection {
  title: string;
  body: string;
}

/** Split a projection file into `## title` + body sections. */
function splitSections(text: string): MarkdownSection[] {
  const lines = text.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { title: line.slice(3), body: '' };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('# ')) continue; // file header
    current.body += (current.body ? '\n' : '') + line;
  }
  if (current) sections.push(current);
  return sections;
}
