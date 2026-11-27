import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { ReportService } from '../tasks/reportService.js';
import { MemoryStore } from '../memory/store.js';
import { FeedbackError, processFeedback, type FeedbackVerdict } from '../memory/feedback.js';
import { ShareError, ShareService } from './shareService.js';

/**
 * Share-link routes (access control, phase 2).
 *
 * PUBLIC (exempt from the login guard — see authRoutes):
 *   GET  /api/share/:token/report     read-only report view for a share token
 *   POST /api/share/:token/feedback   verdict on one issue of THAT report
 *
 * ADMIN (behind the login guard as usual):
 *   GET    /api/tasks/:id/share    -> { token, url } | 404
 *   POST   /api/tasks/:id/share    -> create (idempotent), 201
 *   POST   /api/tasks/:id/share/rotate   -> new token, old URLs die
 *   DELETE /api/tasks/:id/share     -> revoke, all URLs die
 *
 * The public route never exposes raw report JSON. Feedback is scoped by the
 * token: the issue must belong to the token's task, so a share link can only
 * annotate its own report.
 */
export function buildShareRoutes(
  db: Database.Database,
  reports: ReportService,
  options: { baseUrl?: string; dataDir?: string } = {}
): {
  register: (app: FastifyInstance) => void;
  service: ShareService;
  /** Share URL for a task, creating the token on demand (null = no task). */
  shareUrlFor: (taskId: number) => string | null;
} {
  const service = new ShareService(db, reports);
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const memory = options.dataDir ? new MemoryStore(db, options.dataDir) : null;

  const shareUrlFor = (taskId: number): string | null => {
    try {
      const row = service.ensure(taskId);
      return `${baseUrl}/share/${row.token}`;
    } catch {
      return null;
    }
  };

  const register = (app: FastifyInstance) => {
    // Public, guard-exempt: token in the path IS the authorization.
    app.get('/api/share/:token/report', async (req, reply) => {
      const { token } = req.params as { token: string };
      const view = service.sharedReport(token);
      if (!view) return reply.code(404).send({ message: '分享链接不存在或已失效' });
      return view;
    });

    // Public feedback: the token scopes which task the issue must belong to.
    app.post('/api/share/:token/feedback', async (req, reply) => {
      const { token } = req.params as { token: string };
      const taskId = service.taskIdFor(token);
      if (taskId === undefined) {
        return reply.code(404).send({ message: '分享链接不存在或已失效' });
      }
      if (!memory) return reply.code(503).send({ message: '反馈功能未启用' });
      const body = (req.body ?? {}) as { issueId?: number; verdict?: string; note?: string };
      if (!body.issueId || !Number.isSafeInteger(body.issueId) || body.issueId < 1) {
        return reply.code(400).send({ message: 'issueId 必须为正整数' });
      }
      if (!['false_positive', 'fixed', 'wont_fix'].includes(String(body.verdict))) {
        return reply.code(400).send({ message: 'verdict 无效' });
      }
      try {
        return processFeedback(db, memory, taskId, {
          issueId: body.issueId,
          verdict: body.verdict as FeedbackVerdict,
          note: body.note,
        });
      } catch (err) {
        if (err instanceof FeedbackError) {
          return reply.code(err.statusCode).send({ message: err.message });
        }
        throw err;
      }
    });

    const handle = (err: unknown, reply: import('fastify').FastifyReply) => {
      if (err instanceof ShareError) return reply.code(err.statusCode).send({ message: err.message });
      throw err;
    };

    app.get('/api/tasks/:id/share', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const row = service.get(Number(id));
        if (!row) return reply.code(404).send({ message: '该任务没有分享链接' });
        return { token: row.token, url: `${baseUrl}/share/${row.token}`, rotatedAt: row.rotated_at };
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.post('/api/tasks/:id/share', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const row = service.ensure(Number(id));
        return reply.code(201).send({
          token: row.token,
          url: `${baseUrl}/share/${row.token}`,
          rotatedAt: row.rotated_at,
        });
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.post('/api/tasks/:id/share/rotate', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const row = service.rotate(Number(id));
        return {
          token: row.token,
          url: `${baseUrl}/share/${row.token}`,
          rotatedAt: row.rotated_at,
        };
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.delete('/api/tasks/:id/share', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        service.revoke(Number(id));
        return reply.code(204).send();
      } catch (err) {
        return handle(err, reply);
      }
    });
  };

  return { register, service, shareUrlFor };
}
