import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  McpConfigError,
  type McpServerInput,
} from './service.js';
import { probeMcpServer } from './probe.js';

/**
 * MCP server registry REST API (admin-only: the global auth guard covers
 * every /api route in the single-admin model — see mcp-integration spec).
 *
 * GET    /api/mcp-servers
 * POST   /api/mcp-servers
 * PUT    /api/mcp-servers/:id
 * DELETE /api/mcp-servers/:id
 * POST   /api/mcp-servers/:id/test   connectivity check (never mutates)
 */
export function buildMcpRoutes(db: Database.Database): {
  register: (app: FastifyInstance) => void;
} {
  const handleError = (err: unknown, reply: import('fastify').FastifyReply) => {
    if (err instanceof McpConfigError) {
      return reply.code(err.statusCode).send({ message: err.message });
    }
    throw err;
  };

  const register = (app: FastifyInstance) => {
    app.get('/api/mcp-servers', async () => {
      return listMcpServers(db);
    });

    app.post('/api/mcp-servers', async (req, reply) => {
      const input = (req.body ?? {}) as McpServerInput;
      try {
        return reply.code(201).send(createMcpServer(db, input));
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.put('/api/mcp-servers/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const input = (req.body ?? {}) as McpServerInput;
      try {
        return updateMcpServer(db, Number(id), input);
      } catch (err) {
        return handleError(err, reply);
      }
    });

    app.delete('/api/mcp-servers/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        deleteMcpServer(db, Number(id));
        return reply.code(204).send();
      } catch (err) {
        return handleError(err, reply);
      }
    });

    // Connectivity test: reports handshake result + tool list in the body
    // (a failing probe is a normal outcome, not a transport error).
    app.post('/api/mcp-servers/:id/test', async (req) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { timeoutSec?: number };
      return probeMcpServer(db, Number(id), body.timeoutSec);
    });
  };

  return { register };
}
