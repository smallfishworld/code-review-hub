import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rankEntries } from './retrieval.js';
import type { MemoryEntry } from './store.js';

/**
 * Read-only stdio MCP bridge for project memory (openspec memory-mcp-bridge).
 *
 * Spawned by ocr as `mcp_servers["memory.query"]`; configuration arrives via
 * env (CRP_DATA_DIR / CRP_REPO_ID — written by the injector), and the tool
 * parameters deliberately carry NO repo identifier: every query is forced
 * through `WHERE repo_id = ?`, so cross-repo reads are structurally
 * unreachable.
 *
 * The bridge opens the platform SQLite READ-ONLY (WAL multi-process reads are
 * safe) and exposes exactly three read-only tools. There are no write tools
 * by design — memory writes must stay inside the governed distillation /
 * feedback pipelines.
 */

export const BUILTIN_MEMORY_QUERY = 'memory.query';

export interface BridgeTools {
  memory_search: (args: { query?: unknown; kind?: unknown; limit?: unknown }) => Promise<string>;
  memory_get: (args: { id?: unknown }) => Promise<string>;
  memory_stats: (args: Record<string, unknown>) => Promise<string>;
}

const BODY_LIMIT = 2000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const KINDS = ['architecture', 'convention', 'pitfall', 'suppression', 'history', 'glossary'];

function ftsAvailable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM setting WHERE key = 'memory_fts_available'")
    .get() as { value: string } | undefined;
  return row?.value === '1';
}

function entryFromRow(row: Record<string, unknown>): MemoryEntry {
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
    sourceTaskId: (row.source_task_id as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: null,
  };
}

function truncate(text: string, limit = BODY_LIMIT): string {
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function toDto(e: MemoryEntry): Record<string, unknown> {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    scope: e.scope,
    body: truncate(e.body),
    confidence: Number(e.confidence.toFixed(2)),
    hits: e.hits,
    feedbackCount: e.feedbackCount,
    status: e.status,
    updatedAt: e.updatedAt,
    sourceTaskId: e.sourceTaskId,
  };
}

/** Create the read-only tool handlers bound to one repo scope. */
export function createBridgeTools(db: Database.Database, repoId: number): BridgeTools {
  return {
    async memory_search(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return '请提供 query 搜索词';
      const kind = typeof args.kind === 'string' && KINDS.includes(args.kind) ? args.kind : null;
      let limit = Number(args.limit);
      if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));

      // FTS trigram first (only terms >= 3 chars can produce trigrams — short
      // CJK terms would silently match nothing); empty result falls back to a
      // LIKE scan over all terms (OR semantics for recall), then ranking.
      let rows = ftsAvailable(db) ? ftsSearch(db, repoId, query, kind) : [];
      if (rows.length === 0) rows = likeSearch(db, repoId, query, kind);
      const ranked = rankEntries(rows, Date.now()).sort((a, b) => b.score - a.score);
      if (ranked.length === 0) {
        return kind
          ? `该仓库没有匹配「${query}」的 ${kind} 类记忆`
          : `该仓库没有匹配「${query}」的记忆`;
      }
      const out = ranked.slice(0, limit).map((s) => toDto(s.entry));
      return JSON.stringify({ count: out.length, entries: out }, null, 1);
    },

    async memory_get(args) {
      const id = Number(args.id);
      if (!Number.isSafeInteger(id) || id <= 0) return 'id 必须是正整数';
      // repo_id is part of the predicate: another repo's id is unreachable.
      const row = db
        .prepare('SELECT * FROM memory_entry WHERE id = ? AND repo_id = ?')
        .get(id, repoId) as Record<string, unknown> | undefined;
      if (!row) return `未找到 id=${id} 的记忆（或属于其他仓库）`;
      return JSON.stringify(toDto(entryFromRow(row)), null, 1);
    },

    async memory_stats() {
      const byKind: Record<string, number> = {};
      const rows = db
        .prepare(
          "SELECT kind, COUNT(*) AS n FROM memory_entry WHERE repo_id = ? AND status = 'active' GROUP BY kind"
        )
        .all(repoId) as unknown as { kind: string; n: number }[];
      let active = 0;
      for (const r of rows) {
        byKind[r.kind] = r.n;
        active += r.n;
      }
      const archived = (
        db
          .prepare("SELECT COUNT(*) AS n FROM memory_entry WHERE repo_id = ? AND status = 'archived'")
          .get(repoId) as { n: number }
      ).n;
      const reviewCount = (
        db
          .prepare('SELECT value FROM setting WHERE key = ?')
          .get('memory_review_count_' + String(repoId)) as { value: string } | undefined
      )?.value;
      return JSON.stringify(
        {
          active,
          archived,
          byKind,
          ftsAvailable: ftsAvailable(db),
          reviewCount: reviewCount ? Number(reviewCount) : 0,
        },
        null,
        1
      );
    },
  };
}

/** FTS5 search: terms >= 3 chars (trigram minimum), double-quoted, AND. */
function ftsSearch(
  db: Database.Database,
  repoId: number,
  query: string,
  kind: string | null
): MemoryEntry[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (terms.length === 0) return [];
  const match = terms.join(' ');
  const rows = (
    kind
      ? db
          .prepare(
            `SELECT memory_entry.* FROM memory_fts
             JOIN memory_entry ON memory_entry.id = memory_fts.rowid
             WHERE memory_fts MATCH ? AND memory_entry.repo_id = ? AND memory_entry.status = 'active' AND memory_entry.kind = ?
             LIMIT 20`
          )
          .all(match, repoId, kind)
      : db
          .prepare(
            `SELECT memory_entry.* FROM memory_fts
             JOIN memory_entry ON memory_entry.id = memory_fts.rowid
             WHERE memory_fts MATCH ? AND memory_entry.repo_id = ? AND memory_entry.status = 'active'
             LIMIT 20`
          )
          .all(match, repoId)
  ) as Record<string, unknown>[];
  return rows.map(entryFromRow);
}

/** LIKE fallback: all terms OR'd (recall first; ranking orders the hits). */
function likeSearch(
  db: Database.Database,
  repoId: number,
  query: string,
  kind: string | null
): MemoryEntry[] {
  const terms = query.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return [];
  const conds = terms.map(() => '(title LIKE ? OR body LIKE ?)').join(' OR ');
  const params: string[] = [];
  for (const t of terms) params.push(`%${t}%`, `%${t}%`);
  const sql =
    `SELECT * FROM memory_entry WHERE repo_id = ? AND status = 'active'` +
    (kind ? ' AND kind = ?' : '') +
    ` AND (${conds}) LIMIT 20`;
  const args: (string | number)[] = kind ? [repoId, kind, ...params] : [repoId, ...params];
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map(entryFromRow);
}

/** Tool declarations served on tools/list (schema mirrors ocr's tool style). */
export const TOOL_DEFS = [
  {
    name: 'memory_search',
    description:
      '查询本项目（当前仓库）沉淀的项目记忆：项目约定、已知坑点、已确认误报（suppression）、历史修复等。用简短关键词搜索，例如 "空指针"、"logger 约定"、"误报"。查询 suppression 可以了解哪些问题已被人工确认为误报，避免重复报告。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（支持中文；多个词用空格分隔为 AND）' },
        kind: {
          type: 'string',
          enum: KINDS,
          description: '可选：限定记忆类型',
        },
        limit: { type: 'integer', description: '返回条数上限（默认 5，最大 10）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: '按 id 获取一条项目记忆的完整内容（正文、作用范围、来源评审任务）。',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'memory_search 返回的条目 id' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_stats',
    description: '查看本项目当前记忆库的统计（各类条目数、全文检索可用性、已完成评审次数）。',
    input_schema: { type: 'object', properties: {} },
  },
] as const;

/** Dispatch one tools/call. Never throws: failures become tool output text. */
export async function runTool(
  db: Database.Database,
  repoId: number,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tools = createBridgeTools(db, repoId);
  switch (name) {
    case 'memory_search':
      return tools.memory_search(args);
    case 'memory_get':
      return tools.memory_get(args);
    case 'memory_stats':
      return tools.memory_stats(args);
    default:
      return `未知工具: ${name}`;
  }
}

/** Open the platform database read-only; returns a reason string on failure. */
export function openReadonly(dataDir: string): { db?: Database.Database; error?: string } {
  // The platform db file is platform.db (openDatabase default; configurable
  // via DbOptions.fileName — that option doesn't reach the bridge env, so the
  // bridge tries both known names).
  const candidates = [join(dataDir, 'platform.db'), join(dataDir, 'app.db')];
  const dbPath = candidates.find((p) => existsSync(p));
  if (!dbPath) return { error: `记忆库文件不存在（尝试: ${candidates.join(', ')}）` };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    return { db };
  } catch (err) {
    return { error: `记忆库打开失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * stdio entry: newline-delimited JSON-RPC. Supports initialize / tools/list /
 * tools/call; notifications (no id) are ignored. ocr's MCP client speaks this
 * framing (verified live against codegraph serve --mcp).
 */
export async function main(): Promise<void> {
  const dataDir = process.env.CRP_DATA_DIR;
  const repoId = Number(process.env.CRP_REPO_ID);
  if (!dataDir || !Number.isSafeInteger(repoId) || repoId <= 0) {
    console.error(
      'memory-mcp-bridge 需要环境变量 CRP_DATA_DIR（平台数据目录）与 CRP_REPO_ID（仓库 id）；本进程由平台评审时自动注入，请勿手工启动。'
    );
    process.exit(1);
  }
  const opened = openReadonly(dataDir);
  if (!opened.db) {
    console.error(`memory-mcp-bridge: ${opened.error}`);
    process.exit(1);
  }
  const db = opened.db;

  const reply = (id: unknown, result: unknown): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };
  const replyError = (id: unknown, code: number, message: string): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    void (async () => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: {
          id?: unknown;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.id === undefined || msg.id === null) continue; // notification
        switch (msg.method) {
          case 'initialize':
            reply(msg.id, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: BUILTIN_MEMORY_QUERY, version: '1.0.0' },
            });
            break;
          case 'tools/list':
            reply(msg.id, { tools: TOOL_DEFS });
            break;
          case 'tools/call': {
            const name = msg.params?.name ?? '';
            const args = msg.params?.arguments ?? {};
            try {
              const text = await runTool(db, repoId, name, args);
              reply(msg.id, { content: [{ type: 'text', text }], isError: false });
            } catch (err) {
              const text = `记忆查询失败: ${err instanceof Error ? err.message : String(err)}`;
              reply(msg.id, { content: [{ type: 'text', text }], isError: false });
            }
            break;
          }
          default:
            replyError(msg.id, -32601, `method not found: ${msg.method ?? '(none)'}`);
        }
      }
    })();
  });
  process.stdin.on('end', () => {
    db.close();
    process.exit(0);
  });
}
