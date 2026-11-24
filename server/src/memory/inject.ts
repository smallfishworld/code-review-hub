import type Database from 'better-sqlite3';
import type { MemoryEntry } from './store.js';
import { estimateTokens, formatAcceptedRiskOrigin, type ReviewMemoryEntry } from './retrieval.js';

/**
 * Render the retrieved memory entries into the pre-review context text sent
 * to the engine and record the injection audit (memory_injection).
 */

const KIND_LABEL: Record<string, string> = {
  architecture: '项目架构',
  convention: '项目约定',
  pitfall: '已知坑点',
  suppression: '已确认误报（评审时无需重复报告此类问题）',
  history: '历史修复',
  glossary: '术语表',
};

export function renderMemoryContext(entries: ReviewMemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = [
    '【项目背景（来自平台项目记忆，供评审参考）】',
    `共 ${entries.length} 条，按相关性排序：`,
    '',
  ];
  if (entries.some((entry) => entry.acceptedRisk)) {
    lines.push(
      '评审已接受的风险时，先核对原问题的位置、行为和触发条件，再用当前代码验证不修复原因是否仍适用。原评审行号用于辅助定位。',
      '确认是同一问题后，仅在有证据表明原理由已失效，或触发条件、影响范围、严重程度发生实质变化时重新报告，并在报告中说明变化及证据。',
      '这项判断仅适用于已匹配的原问题。其他问题按常规标准评审。',
      ''
    );
  }
  for (const e of entries) {
    const kind = e.acceptedRisk ? '已接受的风险' : KIND_LABEL[e.kind] ?? e.kind;
    lines.push(`### ${kind} — ${e.title}`);
    if (e.acceptedRisk) lines.push(formatAcceptedRiskOrigin(e.acceptedRisk));
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
export function contextTokens(entries: ReviewMemoryEntry[]): number {
  return estimateTokens(renderMemoryContext(entries));
}
