import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import type { LogService, LogLevel } from './logService.js';

/**
 * Log viewing API for the web console.
 *
 * GET  /api/logs          -> latest buffered lines (filters: level, src, q, limit)
 * GET  /api/logs/files    -> downloadable daily files
 * GET  /api/logs/files/:name -> raw file download
 * POST /api/logs/level    -> change the minimum level captured at runtime
 */

const LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);

export function buildLogRoutes(logs: LogService): { register: (app: FastifyInstance) => void } {
  const register = (app: FastifyInstance) => {
    app.get('/api/logs', async (req) => {
      const query = req.query as { limit?: string; level?: string; src?: string; q?: string };
      const limit = query.limit ? Number(query.limit) : undefined;
      const level = query.level && LEVELS.has(query.level) ? (query.level as LogLevel) : undefined;
      return logs.recent({
        limit: Number.isFinite(limit) ? limit : undefined,
        level,
        src: query.src || undefined,
        q: query.q || undefined,
      });
    });

    app.get('/api/logs/files', async () => ({ files: logs.files() }));

    app.get('/api/logs/files/:name', async (req, reply) => {
      const { name } = req.params as { name: string };
      const path = logs.filePath(name);
      if (!path) return reply.code(404).send({ message: '日志文件不存在' });
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="${name}"`
      );
      return reply.send(createReadStream(path));
    });

    app.post('/api/logs/level', async (req, reply) => {
      const body = (req.body ?? {}) as { level?: string };
      if (!body.level || !LEVELS.has(body.level)) {
        return reply.code(400).send({ message: '级别必须是 debug / info / warn / error' });
      }
      logs.setLevel(body.level as LogLevel);
      return { ok: true, level: logs.getLevel() };
    });
  };
  return { register };
}
