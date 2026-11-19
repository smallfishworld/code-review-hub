import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import type { TaskQueue } from './taskQueue.js';
import { TriggerService, TriggerError } from './triggerService.js';
import { ReportService } from './reportService.js';

/**
 * Manual trigger + task query REST API.
 *
 * POST /api/repos/:id/review       { node, force? }
 * POST /api/repos/:id/review-range { from, to, force? }
 * GET  /api/tasks                   ?repoId&node&author&status&trigger&limit&offset
 * GET  /api/tasks/:id
 * GET  /api/tasks/:id/report        (index + issues + raw JSON)
 * POST /api/tasks/:id/cancel
 */
export function buildTaskRoutes(
  db: Database.Database,
  credentials: CredentialService,
  queue: TaskQueue,
  dataDir: string
): { register: (app: FastifyInstance) => void; service: TriggerService } {
  const service = new TriggerService(db, credentials, queue, dataDir);
  const reports = new ReportService(db);

  const handleError = (err: unknown, reply: import('fastify').FastifyReply) => {
    if (err instanceof TriggerError) return reply.code(err.statusCode).send({ message: err.message });
    throw err;
  };

  const register = (app: FastifyInstance) => {
    app.post('/api/repos/:id/review', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { node?: string; force?: boolean };
      if (!body.node || typeof body.node !== 'string') {
        return reply.code(400).send({ message: '缺少 node 参数' });
      }
      try {
        const result = await service.triggerSingle(Number(id), body.node, { force: body.force });
        if (result.duplicate) {
          return reply.code(409).send({
            message: '该节点已评审过，如需重新评审请带 force=true 再次请求',
            duplicate: true,
          });
        }
        return reply.code(201).send({ task: result.task, duplicate: false });
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.post('/api/repos/:id/review-range', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { from?: string; to?: string; force?: boolean };
      if (!body.from || !body.to) {
        return reply.code(400).send({ message: '缺少 from/to 参数' });
      }
      try {
        const result = await service.triggerRange(Number(id), body.from, body.to, {
          force: body.force,
        });
        return reply.code(201).send(result);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.get('/api/tasks', async (req) => {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      return queue.list({
        repoId: q.repoId !== undefined && q.repoId !== '' ? Number(q.repoId) : undefined,
        repoType: q.repoType === 'svn' || q.repoType === 'git' ? q.repoType : undefined,
        node: q.node || undefined,
        author: q.author || undefined,
        status: (q.status || undefined) as never,
        trigger: (q.trigger || undefined) as never,
        limit: q.limit ? Math.min(Number(q.limit), 200) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
    });

    app.get('/api/tasks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return queue.get(Number(id));
      } catch {
        return reply.code(404).send({ message: '任务不存在' });
      }
    });

    app.get('/api/tasks/:id/report', async (req, reply) => {
      const { id } = req.params as { id: string };
      const detail = reports.detail(Number(id));
      if (!detail) return reply.code(404).send({ message: '该任务暂无报告' });
      return detail;
    });

    app.post('/api/tasks/:id/cancel', async (req, reply) => {
      const { id } = req.params as { id: string };
      // A missing task and a finished task both make cancel() return false;
      // report them differently so a stale link does not look like "already
      // finished" (which the UI would show as an ordinary, expected state).
      // queue.get() throws for a missing row, so probe the table directly.
      const exists = db.prepare('SELECT 1 FROM task WHERE id = ?').get(Number(id));
      if (!exists) return reply.code(404).send({ message: '任务不存在' });
      const ok = queue.cancel(Number(id));
      if (!ok) return reply.code(409).send({ message: '任务已结束，无法取消' });
      return { task: queue.get(Number(id)) };
    });
  };

  return { register, service };
}
