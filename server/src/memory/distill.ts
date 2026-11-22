import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { resolveRepositoryProvider } from '../providers/ocrProviderConfig.js';
import { MemoryStore, type MemoryEntry, type MemoryKind } from './store.js';

/**
 * Post-review memory distillation (design D6): after a successful review, a
 * single LLM call proposes up to 5 candidate memories as strict JSON; they
 * merge into existing entries (same kind + scope + normalized title, or FTS
 * mutual hit) by weighted confidence instead of duplicating. Failures are
 * recorded in `setting.memory_distill_last_error` and NEVER affect the task.
 */

export interface DistillCandidate {
  kind: MemoryKind;
  scope: string | null;
  title: string;
  body: string;
  confidence: number;
}

export interface DistillContext {
  repoId: number;
  taskId: number;
  changedFiles: string[];
  /** Normalized issue descriptions from the report (top N). */
  issueSummaries: string[];
}

/** Minimal provider call: anthropic / openai protocols (LLM). */
export async function callLlm(settings: {
  apiBase: string;
  apiKey: string | null;
  model: string;
  protocol: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const base = settings.apiBase.replace(/\/+$/, '');
  if (settings.protocol === 'anthropic' || settings.protocol === 'anthropic-bedrock') {
    if (settings.protocol === 'anthropic-bedrock') {
      throw new Error('Bedrock 协议需要 AWS 签名，蒸馏暂不支持该 Provider');
    }
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: settings.maxTokens ?? 2000,
        messages: [{ role: 'user', content: settings.prompt }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content?: { text?: string }[] };
    return data.content?.map((c) => c.text ?? '').join('') ?? '';
  }
  // openai / openai-responses
  const path = settings.protocol === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey ?? ''}`,
    },
    body: JSON.stringify({
      model: settings.model,
      max_output_tokens: settings.maxTokens ?? 2000,
      input: settings.prompt,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    output_text?: string;
    choices?: { message?: { content?: string } }[];
  };
  return data.output_text ?? data.choices?.[0]?.message?.content ?? '';
}

const MAX_CANDIDATES = 5;

export function buildDistillPrompt(ctx: DistillContext): string {
  return [
    '你是一个代码评审平台的项目记忆蒸馏器。根据本次评审的变更文件和评审发现，',
    '提炼值得长期记住的项目级知识（架构/约定/坑点/术语）。只输出 JSON 数组，',
    '每个元素形如 {"kind":"architecture|convention|pitfall|glossary","scope":"路径前缀或null","title":"...","body":"...","confidence":0.4}，',
    `最多 ${MAX_CANDIDATES} 条；没有值得沉淀的内容时输出 []。不要输出任何其他文字。`,
    '',
    `变更文件: ${ctx.changedFiles.slice(0, 30).join(', ') || '（无）'}`,
    '',
    '评审发现摘要:',
    ...(ctx.issueSummaries.length > 0 ? ctx.issueSummaries.slice(0, 20) : ['（本次无发现）']),
  ].join('\n');
}

/** Parse the model output into candidates (tolerant, capped). */
export function parseDistillOutput(text: string): DistillCandidate[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const KINDS: MemoryKind[] = ['architecture', 'convention', 'pitfall', 'glossary'];
  const out: DistillCandidate[] = [];
  for (const raw of parsed.slice(0, MAX_CANDIDATES)) {
    const c = raw as Record<string, unknown>;
    const kind = c.kind as MemoryKind;
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    const body = typeof c.body === 'string' ? c.body.trim() : '';
    if (!KINDS.includes(kind) || !title || !body) continue;
    out.push({
      kind,
      scope: typeof c.scope === 'string' && c.scope.trim() ? c.scope.trim() : null,
      title,
      body,
      confidence: typeof c.confidence === 'number' ? Math.min(0.6, Math.max(0.2, c.confidence)) : 0.4,
    });
  }
  return out;
}

/**
 * Run one distillation. Async fire-and-forget from the task completion hook;
 * all failures land in `setting.memory_distill_last_error`.
 */
export async function runDistillation(
  db: Database.Database,
  credentials: CredentialService,
  store: MemoryStore,
  ctx: DistillContext
): Promise<{ created: number; merged: number } | null> {
  try {
    const provider = resolveRepositoryProvider(db, credentials, ctx.repoId);
    if (!provider || !provider.apiKey) return null;
    const prompt = buildDistillPrompt(ctx);
    const text = await callLlm({
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      model: provider.model,
      protocol: provider.protocol,
      prompt,
    });
    const candidates = parseDistillOutput(text);
    let created = 0;
    let merged = 0;
    for (const c of candidates) {
      const existing = findMergable(db, store, ctx.repoId, c);
      if (existing) {
        const total = existing.confidence * 2 + c.confidence;
        store.update(existing.id, {
          body: c.body.length > existing.body.length ? c.body : existing.body,
          confidence: total / 3,
        });
        merged++;
      } else {
        store.create({
          repoId: ctx.repoId,
          kind: c.kind,
          scope: c.scope,
          title: c.title,
          body: c.body,
          confidence: c.confidence,
          sourceTaskId: ctx.taskId,
        });
        created++;
      }
    }
    return { created, merged };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `INSERT INTO setting (key, value) VALUES ('memory_distill_last_error', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(`${new Date().toISOString()} ${msg}`.slice(0, 500));
    return null;
  }
}

/** Merge rule: same kind + scope + normalized title (design D6). */
function findMergable(
  db: Database.Database,
  store: MemoryStore,
  repoId: number,
  candidate: DistillCandidate
): MemoryEntry | null {
  const normalized = candidate.title.replace(/\s+/g, '').toLowerCase();
  const rows = db
    .prepare(
      `SELECT id FROM memory_entry
       WHERE repo_id = ? AND kind = ? AND status IN ('active','archived') ORDER BY id`
    )
    .all(repoId, candidate.kind) as unknown as { id: number }[];
  for (const r of rows) {
    const e = store.get(r.id);
    if (!e) continue;
    if ((e.scope ?? '') !== (candidate.scope ?? '')) continue;
    const norm = e.title.replace(/\s+/g, '').toLowerCase();
    if (norm === normalized) return e;
  }
  return null;
}
