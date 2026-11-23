import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, MemoryError, type MemoryInput, type MemoryKind } from './store.js';
import { MemoryRetrieval } from './retrieval.js';
import { renderMemoryContext } from './inject.js';
import { processFeedback, FeedbackError, type FeedbackInput } from './feedback.js';
import { callLlm } from './distill.js';
import { injectionAuditForTask } from '../mcp/injector.js';
import { workCopyDir } from '../tasks/ocrRunner.js';
import { resolveRepositoryProvider, resolveProvider } from '../providers/ocrProviderConfig.js';
import type { CredentialService } from '../crypto/credentialService.js';

/**
 * Memory + feedback REST API:
 *   GET    /api/repos/:id/memory                 (列表，可带 kind/status)
 *   POST   /api/repos/:id/memory                 (新增)
 *   PUT    /api/repos/:id/memory/:entryId        (编辑/停用/归档)
 *   DELETE /api/repos/:id/memory/:entryId
 *   POST   /api/repos/:id/memory/reload          (手工编辑 markdown 后重载)
 *   POST   /api/repos/:id/memory/profile         (冷启动画像，手动触发)
 *   GET    /api/repos/:id/memory/preview         (预览下一次评审的注入文本)
 *   POST   /api/tasks/:id/feedback               (issue 反馈)
 *   GET    /api/tasks/:id/mcp                    (MCP 注入审计)
 */
export function buildMemoryRoutes(
  db: Database.Database,
  credentials: CredentialService,
  dataDir: string
): { register: (app: FastifyInstance) => void } {
  const store = new MemoryStore(db, dataDir);

  const handleError = (err: unknown, reply: import('fastify').FastifyReply) => {
    if (err instanceof MemoryError || err instanceof FeedbackError) {
      return reply.code(err.statusCode).send({ message: err.message });
    }
    throw err;
  };

  const register = (app: FastifyInstance) => {
    app.get('/api/repos/:id/memory', async (req) => {
      const { id } = req.params as { id: string };
      const q = (req.query ?? {}) as { kind?: string; status?: string };
      return {
        ftsAvailable: store.ftsAvailable(),
        items: store.list(Number(id), {
          kind: q.kind as MemoryKind | undefined,
          status: (q.status as 'active' | 'archived' | 'rejected' | 'all') ?? 'active',
        }),
      };
    });

    app.post('/api/repos/:id/memory', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Partial<MemoryInput>;
      try {
        const entry = store.create({
          repoId: Number(id),
          kind: body.kind as MemoryKind,
          scope: typeof body.scope === 'string' ? body.scope : null,
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
          confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
          status: body.status,
          fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : null,
        });
        return reply.code(201).send(entry);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.put('/api/repos/:id/memory/:entryId', async (req, reply) => {
      const { entryId } = req.params as { entryId: string };
      // Validated positive integer (taint break): only a well-formed id can
      // reach the store.
      const idNum = /^\d{1,15}$/.test(entryId) ? Number(entryId) : NaN;
      if (!Number.isSafeInteger(idNum) || idNum <= 0) {
        return reply.code(400).send({ message: 'entryId 必须是正整数' });
      }
      const body = (req.body ?? {}) as Partial<MemoryInput>;
      try {
        // Explicit field extraction with type guards — only known memory
        // fields can enter the store, never the raw request body.
        const patch: Partial<MemoryInput> = {};
        if (typeof body.kind === 'string') patch.kind = body.kind as MemoryKind;
        if (typeof body.scope === 'string' || body.scope === null) patch.scope = body.scope;
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.body === 'string') patch.body = body.body;
        if (typeof body.confidence === 'number') patch.confidence = body.confidence;
        if (body.status === 'active' || body.status === 'archived' || body.status === 'rejected') {
          patch.status = body.status;
        }
        if (typeof body.fingerprint === 'string' || body.fingerprint === null) {
          patch.fingerprint = body.fingerprint;
        }
        return store.update(idNum, patch);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.delete('/api/repos/:id/memory/:entryId', async (req, reply) => {
      const { entryId } = req.params as { entryId: string };
      const idNum = /^\d{1,15}$/.test(entryId) ? Number(entryId) : NaN;
      if (!Number.isSafeInteger(idNum) || idNum <= 0) {
        return reply.code(400).send({ message: 'entryId 必须是正整数' });
      }
      try {
        store.delete(idNum);
        return reply.code(204).send();
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.post('/api/repos/:id/memory/reload', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return store.reloadFromMarkdown(Number(id));
      } catch (err) {
        return handleError(err, reply);
      }
    });

    // 预览下一次评审的注入文本（scope/FTS 检索用最近一次变更不可得，
    // 这里以全仓库作用域条目预览排序与预算效果）。
    app.get('/api/repos/:id/memory/preview', async (req) => {
      const { id } = req.params as { id: string };
      const retrieval = new MemoryRetrieval(store, db);
      const entries = retrieval.retrieve(Number(id), { changedFiles: [], identifiers: [] });
      return { text: renderMemoryContext(entries), tokens: undefined, count: entries.length };
    });

    // 冷启动画像：扫描工作副本顶层文件 + README/包清单，产出
    // architecture/convention 基础记忆（可重复执行 = 更新不重复新增）。
    app.post('/api/repos/:id/memory/profile', async (req, reply) => {
      const { id } = req.params as { id: string };
      const repoId = Number(id);
      const repo = db.prepare('SELECT id FROM repo WHERE id = ?').get(repoId);
      if (!repo) return reply.code(404).send({ message: '仓库不存在' });
      const wcDir = workCopyDir(dataDir, repoId);
      if (!existsSync(wcDir)) {
        return reply.code(409).send({ message: '工作副本尚未初始化，请先触发一次评审或等待预热完成' });
      }
      try {
        const summary = scanWorkCopy(wcDir);
        // Prefer the repo's model (pool primary / legacy override); otherwise the
        // global default — a repo bound to a model should generate its memory
        // profile with that same model.
        const provider = resolveRepositoryProvider(db, credentials, repoId) ?? resolveProvider(db, credentials);
        if (!provider || !provider.apiKey) {
          return reply.code(409).send({ message: '未配置 LLM Provider（需要 API Key 才能生成画像）' });
        }
        const prompt = buildProfilePrompt(summary);
        const text = await callLlm({
          apiBase: provider.apiBase,
          apiKey: provider.apiKey,
          model: provider.model,
          protocol: provider.protocol,
          prompt,
          maxTokens: 3000,
        });
        const result = upsertProfileEntries(db, store, repoId, text);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ message: `画像生成失败：${msg.slice(0, 300)}` });
      }
    });

    app.post('/api/tasks/:id/feedback', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as FeedbackInput;
      if (!body.issueId || !body.verdict) {
        return reply.code(400).send({ message: '缺少 issueId 或 verdict' });
      }
      if (!['false_positive', 'fixed', 'valid'].includes(body.verdict)) {
        return reply.code(400).send({ message: 'verdict 无效' });
      }
      try {
        return processFeedback(db, store, Number(id), body);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.get('/api/tasks/:id/mcp', async (req) => {
      const { id } = req.params as { id: string };
      return injectionAuditForTask(db, Number(id));
    });

    // 记忆注入审计（任务详情展示注入条数与明细）
    app.get('/api/tasks/:id/memory', async (req) => {
      const { id } = req.params as { id: string };
      const rows = db
        .prepare(
          `SELECT me.id, me.kind, me.title, me.scope, me.confidence
           FROM memory_injection mi JOIN memory_entry me ON me.id = mi.memory_id
           WHERE mi.task_id = ? ORDER BY me.id`
        )
        .all(Number(id)) as unknown as {
        id: number;
        kind: string;
        title: string;
        scope: string | null;
        confidence: number;
      }[];
      return { count: rows.length, entries: rows };
    });
  };

  return { register };
}

/** Rough working-copy scan for the cold-start profile prompt. */
function scanWorkCopy(wcDir: string): string {
  const lines: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(wcDir).filter((n) => !n.startsWith('.')).slice(0, 50);
  } catch {
    entries = [];
  }
  lines.push('顶层文件/目录: ' + (entries.join(', ') || '（空）'));
  for (const manifest of ['package.json', 'pom.xml', 'build.gradle', 'Cargo.toml', 'go.mod', 'README.md']) {
    const file = join(wcDir, manifest);
    if (existsSync(file)) {
      const head = readFileSync(file, 'utf8').slice(0, 1200);
      lines.push('', '--- ' + manifest + ' (头部) ---', head);
    }
  }
  return lines.join('\n');
}

function buildProfilePrompt(summary: string): string {
  return [
    '你是代码评审平台的项目画像生成器。根据以下项目工作副本摘要，输出 JSON 数组（最多 8 条），',
    '每条形如 {"kind":"architecture|convention","scope":null,"title":"...","body":"...","confidence":0.6}。',
    '覆盖：技术栈、模块划分、构建与测试方式、关键约定。只输出 JSON，不要其他文字。',
    '',
    summary,
  ].join('\n');
}

/** Upsert profile entries (repeated generation updates, never duplicates). */
function upsertProfileEntries(
  db: Database.Database,
  store: MemoryStore,
  repoId: number,
  text: string
): { updated: number; created: number } {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('模型输出不是 JSON 数组');
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>[];
  let updated = 0;
  let created = 0;
  for (const raw of parsed.slice(0, 8)) {
    const kind = raw.kind as MemoryKind;
    if (kind !== 'architecture' && kind !== 'convention') continue;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (!title || !body) continue;
    const existing = store.findByTitle(repoId, kind, title);
    if (existing) {
      store.update(existing.id, { title, body, kind });
      updated++;
    } else {
      store.create({
        repoId,
        kind,
        scope: null,
        title,
        body,
        confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.6,
      });
      created++;
    }
  }
  return { updated, created };
}
