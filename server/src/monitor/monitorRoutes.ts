import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { MonitorService } from './monitorService.js';

/**
 * Monitor rule configuration + status API.
 *
 * GET    /api/monitor/rules            all rules with status
 * GET    /api/monitor/rules/:repoId    one rule by repo
 * PUT    /api/monitor/rules/:repoId    create/update rule (upsert)
 * POST   /api/monitor/rules/:repoId/enable
 * POST   /api/monitor/rules/:repoId/disable
 * POST   /api/monitor/rules/:repoId/poll   trigger one poll now
 * GET    /api/monitor/status           status panel for all rules
 */

export interface MonitorRuleInput {
  intervalSeconds?: number;
  authorWhitelist?: string[];
  pathPrefixes?: string[];
  backtrackNodes?: number;
  enabled?: boolean;
  engineId?: number | null;
}

export class MonitorRuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

interface RuleRow {
  id: number;
  repo_id: number;
  interval_seconds: number;
  author_whitelist: string;
  path_prefixes: string;
  backtrack_nodes: number;
  enabled: number;
  engine_id: number | null;
  created_at: string;
  updated_at: string;
}

export function buildMonitorRoutes(
  db: Database.Database,
  monitor: MonitorService
): { register: (app: FastifyInstance) => void } {
  const toDto = (row: RuleRow) => ({
    id: row.id,
    repoId: row.repo_id,
    intervalSeconds: row.interval_seconds,
    authorWhitelist: safeArray(row.author_whitelist),
    pathPrefixes: safeArray(row.path_prefixes),
    backtrackNodes: row.backtrack_nodes,
    enabled: row.enabled === 1,
    engineId: row.engine_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const getRuleByRepo = (repoId: number): RuleRow | undefined =>
    db.prepare('SELECT * FROM monitor_rule WHERE repo_id = ?').get(repoId) as RuleRow | undefined;

  const validate = (input: MonitorRuleInput) => {
    if (input.engineId != null && (!Number.isInteger(input.engineId) ||
      !db.prepare('SELECT 1 FROM engine WHERE id = ?').get(input.engineId))) {
      throw new MonitorRuleError('评审引擎不存在');
    }
    if (input.intervalSeconds !== undefined) {
      if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 30) {
        throw new MonitorRuleError('轮询间隔必须是不小于 30 的整数（秒）');
      }
    }
    if (input.backtrackNodes !== undefined) {
      if (!Number.isInteger(input.backtrackNodes) || input.backtrackNodes < 0) {
        throw new MonitorRuleError('回溯节点数必须是非负整数');
      }
    }
    for (const key of ['authorWhitelist', 'pathPrefixes'] as const) {
      const v = input[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
        throw new MonitorRuleError(`${key} 必须是字符串数组`);
      }
    }
  };

  const register = (app: FastifyInstance) => {
    app.get('/api/monitor/rules', async () => {
      const rows = db.prepare('SELECT * FROM monitor_rule ORDER BY id').all() as RuleRow[];
      const statuses = new Map(monitor.status().map((s) => [s.ruleId, s]));
      return rows.map((r) => ({ ...toDto(r), status: statuses.get(r.id) ?? null }));
    });

    app.get('/api/monitor/rules/:repoId', async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const row = getRuleByRepo(Number(repoId));
      if (!row) return reply.code(404).send({ message: '该仓库尚未配置监控规则' });
      return { ...toDto(row), status: monitor.status(row.id)[0] ?? null };
    });

    app.put('/api/monitor/rules/:repoId', async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const id = Number(repoId);
      const repo = db.prepare('SELECT id, type FROM repo WHERE id = ?').get(id) as
        | { id: number; type: string }
        | undefined;
      if (!repo) return reply.code(404).send({ message: '仓库不存在' });
      const input = (req.body ?? {}) as MonitorRuleInput;
      try {
        validate(input);
      } catch (err) {
        if (err instanceof MonitorRuleError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }

      const existing = getRuleByRepo(id);
      const interval = input.intervalSeconds ?? existing?.interval_seconds ?? 300;
      const authors = JSON.stringify(input.authorWhitelist ?? safeArray(existing?.author_whitelist ?? '[]'));
      const paths = JSON.stringify(input.pathPrefixes ?? safeArray(existing?.path_prefixes ?? '[]'));
      const backtrack = input.backtrackNodes ?? existing?.backtrack_nodes ?? 0;
      const engineId = input.engineId === undefined ? existing?.engine_id ?? null : input.engineId;

      if (existing) {
        db.prepare(
          `UPDATE monitor_rule
           SET interval_seconds = ?, author_whitelist = ?, path_prefixes = ?, backtrack_nodes = ?, engine_id = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`
        ).run(interval, authors, paths, backtrack, engineId, existing.id);
      } else {
        db.prepare(
          `INSERT INTO monitor_rule
             (repo_id, interval_seconds, author_whitelist, path_prefixes, backtrack_nodes, engine_id, enabled)
           VALUES (?, ?, ?, ?, ?, ?, 0)`
        ).run(id, interval, authors, paths, backtrack, engineId);
      }
      const row = getRuleByRepo(id)!;
      // re-arm the timer with the new interval when enabled
      if (row.enabled === 1) monitor.schedule(row);
      return { ...toDto(row), status: monitor.status(row.id)[0] ?? null };
    });

    app.post('/api/monitor/rules/:repoId/enable', async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const row = getRuleByRepo(Number(repoId));
      if (!row) return reply.code(404).send({ message: '该仓库尚未配置监控规则' });
      try {
        await monitor.enableRule(row.id);
      } catch (err) {
        return reply.code(502).send({
          message: `启用监控失败（无法确定起点）: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return { ...toDto(getRuleByRepo(Number(repoId))!), status: monitor.status(row.id)[0] ?? null };
    });

    app.post('/api/monitor/rules/:repoId/disable', async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const row = getRuleByRepo(Number(repoId));
      if (!row) return reply.code(404).send({ message: '该仓库尚未配置监控规则' });
      monitor.disableRule(row.id);
      return { ...toDto(getRuleByRepo(Number(repoId))!), status: monitor.status(row.id)[0] ?? null };
    });

    app.post('/api/monitor/rules/:repoId/poll', async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const row = getRuleByRepo(Number(repoId));
      if (!row) return reply.code(404).send({ message: '该仓库尚未配置监控规则' });
      // "立即轮询" is an explicit operator action: a disabled rule must not
      // silently no-op. Report it instead of returning a success toast.
      if (row.enabled !== 1) {
        return reply.code(409).send({ message: '监控未启用，请先启用监控再执行轮询' });
      }
      const repo = db.prepare('SELECT enabled FROM repo WHERE id = ?').get(Number(repoId)) as
        | { enabled: number }
        | undefined;
      if (repo && repo.enabled === 0) {
        return reply.code(409).send({ message: '仓库已停用，请先在「仓库管理」中启用该仓库' });
      }
      await monitor.pollRule(row.id);
      return { status: monitor.status(row.id)[0] ?? null };
    });

    app.get('/api/monitor/status', async () => monitor.status());
  };

  return { register };
}

function safeArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
