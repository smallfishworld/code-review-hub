import type Database from 'better-sqlite3';
import type { MemoryEntry } from './store.js';
import { estimateTokens } from './retrieval.js';

/**
 * Render the retrieved memory entries into the pre-review context text sent
 * to the engine via `--requirement` (ocr), and record the injection audit
 * (memory_injection) + hit counters. The rendered text has three sections —
 * architecture / known pitfalls / confirmed false positives (design D6).
 */

const KIND_LABEL: Record<string, string> = {
  architecture: '项目架构',
  convention: '项目约定',
  pitfall: '已知坑点',
  suppression: '已确认误报（评审时无需重复报告此类问题）',
  history: '历史修复',
  glossary: '术语表',
};

export function renderMemoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = [
    '【项目背景（来自平台项目记忆，供评审参考）】',
    `共 ${entries.length} 条，按相关性排序：`,
    '',
  ];
  for (const e of entries) {
    lines.push(`### ${KIND_LABEL[e.kind] ?? e.kind} — ${e.title}`);
    lines.push(e.body);
    lines.push('');
  }
  return lines.join('\n');
}

/** Persist injection audit + update hit counters. */
export function recordMemoryInjection(
  db: Database.Database,
  taskId: number,
  entries: MemoryEntry[]
): void {
  if (entries.length === 0) return;
  const insert = db.prepare(
    'INSERT OR REPLACE INTO memory_injection (task_id, memory_id) VALUES (?, ?)'
  );
  const tx = db.transaction(() => {
    for (const e of entries) insert.run(taskId, e.id);
  });
  tx();
}

/** Total token cost of a rendered context (for logs / assertions). */
export function contextTokens(entries: MemoryEntry[]): number {
  return estimateTokens(renderMemoryContext(entries));
}
