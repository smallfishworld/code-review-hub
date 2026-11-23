import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { CredentialService } from '../crypto/credentialService.js';
import { RepoService, RepoServiceError, type RepoInput } from './repoService.js';
import type { WorkspaceInitService } from '../tasks/workspaceInit.js';

/**
 * Repo management REST API. All responses strip secrets: RepoRecord
 * never includes a password; updates with an empty password keep the
 * stored credential unchanged.
 */
export interface RepoRouteOptions {
  /**
   * Called after a repo is updated or deleted so the monitor can re-arm or
   * stop that repo's rule timer (enabling/disabling a repo must actually
   * start/stop polling).
   */
  onRepoChange?: (repoId: number) => void;
  /**
   * Cancels every queued/running task of a repo. Called before the repo row
   * is deleted so running ocr children release their workspace/ocr-home dirs
   * before those are swept off disk.
   */
  cancelRepoTasks?: (repoId: number) => void;
  /** Data directory; the node picker keeps its git clone cache under it. */
  dataDir?: string;
  /**
   * Workspace prewarm: create kicks a background download (SVN checkout /
   * git clone) so the console can show 初始化中 and the first review does
   * not absorb the whole download.
   */
  workspaceInit?: WorkspaceInitService;
}

export function buildRepoRoutes(
  db: Database.Database,
  credentials: CredentialService,
  options: RepoRouteOptions = {}
): { register: (app: FastifyInstance) => void; service: RepoService } {
  const service = new RepoService(db, credentials, options.dataDir);

  const register = (app: FastifyInstance) => {
    app.get('/api/repos', async () => service.list());

    app.get('/api/repos/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return service.get(Number(id));
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    app.post('/api/repos', async (req, reply) => {
      try {
        const input = req.body as RepoInput;
        const created = await service.create(input);
        // Fire-and-forget prewarm; progress is visible via init_status.
        options.workspaceInit?.start(created.id);
        return reply.code(201).send(created);
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    app.put('/api/repos/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const updated = await service.update(Number(id), req.body as RepoInput);
        options.onRepoChange?.(Number(id));
        // URL/credentials may have changed — re-prewarm if the workspace is
        // missing; a present workspace is reused as-is by the runner.
        options.workspaceInit?.start(Number(id));
        return updated;
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    // Prewarm status for the console's 初始化 column (polled while preparing).
    app.get('/api/repos/:id/init-status', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return options.workspaceInit?.statusOf(Number(id)) ?? { status: 'ready', error: null, updatedAt: null };
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    // Manual retry after a failed prewarm (or re-check that it is complete).
    app.post('/api/repos/:id/init', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        service.get(Number(id)); // 404 when the repo is gone
        const started = options.workspaceInit?.start(Number(id)) ?? false;
        if (!started) {
          return reply.code(409).send({ message: '初始化已在进行中' });
        }
        return reply.code(202).send({ started: true });
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    app.get('/api/repos/:id/impact', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return service.describeImpact(Number(id));
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    // Node picker for the manual-trigger page: paged revisions/commits,
    // newest-first, with an optional `q` filter over node/author/message/path.
    app.get('/api/repos/:id/nodes', async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = req.query as { limit?: string; q?: string; cursor?: string };
      try {
        return await service.listNodes(Number(id), {
          limit: query.limit ? Number(query.limit) : undefined,
          query: query.q,
          cursor: query.cursor,
        });
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });

    app.delete('/api/repos/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        // Kill this repo's queued/running reviews first: their ocr children
        // hold locks on the workcopy/ocr-home dirs deleted below (EPERM on
        // Windows), and a task that outlives its repo would fail anyway.
        options.cancelRepoTasks?.(Number(id));
        service.delete(Number(id));
        options.onRepoChange?.(Number(id));
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RepoServiceError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
    });
  };

  return { register, service };
}

/** Build an app with repo routes for integration tests. */
export async function buildTestApp(
  db: Database.Database,
  credentials: CredentialService,
  /** Passed through so tests can exercise the production node-cache path. */
  options: RepoRouteOptions = {}
) {
  const app = Fastify();
  const { register } = buildRepoRoutes(db, credentials, options);
  register(app);
  await app.ready();
  return app;
}
