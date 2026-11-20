import type Database from 'better-sqlite3';
import { defaultEngineId, getEngineRow, type EngineRow } from './registry.js';

/**
 * Three-level engine selection (openspec D2):
 *   监控规则 engine_id → 仓库 engine_id → 全局默认（setting, 兜底第一条 enabled）。
 *
 * Task rows don't carry the triggering rule (multiple auto rules can hit the
 * same node), so the rule level resolves from the repo's enabled monitor
 * rules: the first rule pinning an engine wins. A missing or disabled engine
 * NEVER silently falls back — the task fails with the reason (spec:
 * 三级引擎选择 / 引擎被删除后触发).
 */

export class EngineResolveError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface ResolvedEngine {
  row: EngineRow;
  /** Which level decided: rule | repo | default. */
  source: 'rule' | 'repo' | 'default';
}

export function resolveEngineForRepo(db: Database.Database, repoId: number): ResolvedEngine {
  // 1. rule level: first enabled rule of the repo pinning an engine
  const ruleRow = db
    .prepare(
      `SELECT engine_id FROM monitor_rule
       WHERE repo_id = ? AND enabled = 1 AND engine_id IS NOT NULL
       ORDER BY id LIMIT 1`
    )
    .get(repoId) as { engine_id: number } | undefined;
  if (ruleRow) {
    const row = getEngineRow(db, ruleRow.engine_id);
    if (!row) {
      throw new EngineResolveError(
        `监控规则引用的引擎 #${ruleRow.engine_id} 不存在，任务终止（不回退到其他引擎）`
      );
    }
    if (!row.enabled) {
      throw new EngineResolveError(`监控规则引用的引擎 ${row.name} 已停用，任务终止`);
    }
    return { row, source: 'rule' };
  }

  // 2. repo level
  const repoRow = db
    .prepare('SELECT engine_id FROM repo WHERE id = ?')
    .get(repoId) as { engine_id: number | null } | undefined;
  if (repoRow?.engine_id) {
    const row = getEngineRow(db, repoRow.engine_id);
    if (!row) {
      throw new EngineResolveError(
        `仓库引用的引擎 #${repoRow.engine_id} 不存在，任务终止（不回退到其他引擎）`
      );
    }
    if (!row.enabled) {
      throw new EngineResolveError(`仓库引用的引擎 ${row.name} 已停用，任务终止`);
    }
    return { row, source: 'repo' };
  }

  // 3. global default (setting), falling back to the first enabled engine
  const preferred = defaultEngineId(db);
  const row = (
    preferred !== null
      ? db.prepare('SELECT * FROM engine WHERE id = ?').get(preferred)
      : db.prepare('SELECT * FROM engine WHERE enabled = 1 ORDER BY id LIMIT 1').get()
  ) as Record<string, unknown> | undefined;
  if (!row) {
    throw new EngineResolveError('没有可用的评审引擎（未配置默认引擎）');
  }
  const engine = getEngineRow(db, row.id as number)!;
  if (!engine.enabled) {
    throw new EngineResolveError(`默认引擎 ${engine.name} 已停用，任务终止`);
  }
  return { row: engine, source: 'default' };
}
