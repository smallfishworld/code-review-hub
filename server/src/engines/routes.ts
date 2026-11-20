import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import {
  bootstrapEngines,
  createEngine,
  defaultEngineId,
  getEngineRow,
  rowToEngine,
  setDefaultEngine,
  EngineNotSupportedError,
  type EngineRow,
} from './registry.js';

/**
 * Engine registry REST API (admin via the global auth guard):
 *   GET    /api/engines
 *   POST   /api/engines
 *   PUT    /api/engines/:id          (rename / enable / disable)
 *   DELETE /api/engines/:id
 *   POST   /api/engines/:id/default
 *   GET    /api/engines/:id/capabilities
 */
export function buildEngineRoutes(
  db: Database.Database,
  credentials: CredentialService,
  opts: { dataDir: string }
): { register: (app: FastifyInstance) => void } {
  const KINDS = ['ocr', 'claude-code', 'codex', 'custom-http', 'custom-script'];

  const dto = (row: EngineRow) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled === 1,
    isDefault: defaultEngineId(db) === row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    capabilities: capabilitiesOf(row),
  });

  const capabilitiesOf = (row: EngineRow) => {
    try {
      return createEngine(row, db, credentials, opts).capabilities;
    } catch {
      return null; // 适配器未实现：UI 据此禁用相关配置项
    }
  };

  const register = (app: FastifyInstance) => {
    app.get('/api/engines', async () => {
      bootstrapEngines(db); // 幂等：保证至少有默认 ocr 引擎
      const rows = db.prepare('SELECT * FROM engine ORDER BY id').all() as Record<
        string,
        unknown
      >[];
      return rows.map((r) => dto(rowToEngine(r)));
    });

    app.post('/api/engines', async (req, reply) => {
      const body = (req.body ?? {}) as { name?: string; kind?: string };
      const name = body.name?.trim();
      if (!name) return reply.code(400).send({ message: '名称不能为空' });
      if (!body.kind || !KINDS.includes(body.kind)) {
        return reply.code(400).send({ message: '引擎类型无效' });
      }
      const dup = db.prepare('SELECT id FROM engine WHERE name = ?').get(name);
      if (dup) return reply.code(409).send({ message: `引擎名称 ${name} 已存在` });
      const info = db
        .prepare(`INSERT INTO engine (name, kind, config, enabled) VALUES (?, ?, '{}', 1)`)
        .run(name, body.kind);
      const row = getEngineRow(db, Number(info.lastInsertRowid))!;
      return reply.code(201).send(dto(row));
    });

    app.put('/api/engines/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = getEngineRow(db, Number(id));
      if (!row) return reply.code(404).send({ message: '引擎不存在' });
      const body = (req.body ?? {}) as { name?: string; enabled?: boolean };
      const name = body.name?.trim() || row.name;
      if (name !== row.name) {
        const dup = db.prepare('SELECT id FROM engine WHERE name = ?').get(name);
        if (dup) return reply.code(409).send({ message: `引擎名称 ${name} 已存在` });
      }
      db.prepare(
        `UPDATE engine SET name = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      ).run(name, body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0, row.id);
      return dto(getEngineRow(db, row.id)!);
    });

    app.delete('/api/engines/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = getEngineRow(db, Number(id));
      if (!row) return reply.code(404).send({ message: '引擎不存在' });
      const inUse = db
        .prepare(
          'SELECT COUNT(*) AS n FROM task WHERE engine_id = ?'
        )
        .get(row.id) as { n: number };
      if (inUse.n > 0) {
        return reply.code(409).send({
          message: `引擎被 ${inUse.n} 个历史任务引用，请停用而非删除`,
        });
      }
      db.prepare('DELETE FROM engine WHERE id = ?').run(row.id);
      if (defaultEngineId(db) === row.id) {
        db.prepare("DELETE FROM setting WHERE key = 'default_engine_id'").run();
      }
      return reply.code(204).send();
    });

    app.post('/api/engines/:id/default', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = getEngineRow(db, Number(id));
      if (!row) return reply.code(404).send({ message: '引擎不存在' });
      if (!row.enabled) return reply.code(400).send({ message: '停用的引擎不能设为默认' });
      setDefaultEngine(db, row.id);
      return dto(row);
    });

    app.get('/api/engines/:id/capabilities', async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = getEngineRow(db, Number(id));
      if (!row) return reply.code(404).send({ message: '引擎不存在' });
      try {
        const engine = createEngine(row, db, credentials, opts);
        return await engine.probe();
      } catch (err) {
        if (err instanceof EngineNotSupportedError) {
          return reply.code(400).send({ message: err.message });
        }
        throw err;
      }
    });
  };

  return { register };
}
