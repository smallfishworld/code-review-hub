import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { PROTOCOLS, defaultProviderId, type Protocol } from './ocrProviderConfig.js';
import { testProvider } from './providerTester.js';

/**
 * LLM provider configuration API. Providers are forwarded to the ocr CLI
 * (API base / model / key). Keys are encrypted at rest and never returned.
 *
 * GET    /api/providers
 * POST   /api/providers
 * PUT    /api/providers/:id
 * DELETE /api/providers/:id
 * POST   /api/providers/:id/test   connectivity check
 */

export interface ProviderInput {
  name?: string;
  apiBase?: string;
  model?: string;
  apiKey?: string;
  protocol?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

interface ProviderRow {
  id: number;
  name: string;
  api_base: string;
  model: string;
  protocol: string;
  credential_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderDto {
  id: number;
  name: string;
  apiBase: string;
  model: string;
  protocol: string;
  hasApiKey: boolean;
  apiKey: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRouteOptions {
  /**
   * Overrides for the connectivity test. Tests pin `ocrBin: ''` to force the
   * direct-HTTP path so a developer machine with ocr installed still exercises
   * the stub server.
   */
  testOptions?: { timeoutMs?: number; ocrBin?: string };
}

export function buildProviderRoutes(
  db: Database.Database,
  credentials: CredentialService,
  options: ProviderRouteOptions = {}
): { register: (app: FastifyInstance) => void } {
  const toDto = (row: ProviderRow): ProviderDto => ({
    id: row.id,
    name: row.name,
    apiBase: row.api_base,
    model: row.model,
    protocol: row.protocol ?? 'anthropic',
    isDefault: defaultProviderId(db) === row.id,
    hasApiKey: row.credential_id !== null,
    apiKey: row.credential_id !== null ? '********' : '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const getRow = (id: number): ProviderRow | undefined =>
    db.prepare('SELECT * FROM provider WHERE id = ?').get(id) as ProviderRow | undefined;

  /** Parse a :id path parameter into a validated positive integer (taint break). */
  const parseIdParam = (raw: string): number | null => {
    if (!/^\d{1,15}$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };

  const validate = (input: ProviderInput, partial = false) => {
    const required = (field: keyof ProviderInput, label: string) => {
      const v = input[field];
      if (!partial || v !== undefined) {
        if (typeof v !== 'string' || v.trim() === '') {
          throw new ProviderError(`${label}不能为空`);
        }
      }
    };
    required('name', '名称');
    required('apiBase', 'API 地址');
    required('model', '模型名');
    if (input.protocol !== undefined && !PROTOCOLS.includes(input.protocol as Protocol)) {
      throw new ProviderError(`协议必须是 ${PROTOCOLS.join(' / ')} 之一`);
    }
    if (input.apiBase !== undefined) {
      try {
        const u = new URL(input.apiBase);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        throw new ProviderError('API 地址必须是合法的 http(s) URL');
      }
    }
  };

  const register = (app: FastifyInstance) => {
    app.get('/api/providers', async () => {
      const rows = db.prepare('SELECT * FROM provider ORDER BY id').all() as ProviderRow[];
      return rows.map(toDto);
    });

    app.get('/api/providers/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const idNum = parseIdParam(id);
      if (!idNum) return reply.code(400).send({ message: 'id 必须是正整数' });
      const row = getRow(idNum);
      if (!row) return reply.code(404).send({ message: 'Provider 不存在' });
      return toDto(row);
    });

    app.post('/api/providers', async (req, reply) => {
      const raw = (req.body ?? {}) as ProviderInput;
      // Explicit field extraction with type guards: only known, well-typed
      // provider fields continue past this point (never the raw body).
      const input: ProviderInput = {
        name: typeof raw.name === 'string' ? raw.name : '',
        apiBase: typeof raw.apiBase === 'string' ? raw.apiBase : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
        protocol: typeof raw.protocol === 'string' ? raw.protocol : 'anthropic',
      };
      try {
        validate(input);
      } catch (err) {
        if (err instanceof ProviderError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
      const dup = db.prepare('SELECT id FROM provider WHERE name = ?').get(input.name!.trim());
      if (dup) return reply.code(409).send({ message: `Provider 名称 ${input.name} 已存在` });

      const credentialId = input.apiKey
        ? credentials.store(`provider:${input.name!.trim()}`, 'llm', input.apiKey)
        : null;
      const info = db
        .prepare(
          `INSERT INTO provider (name, api_base, model, protocol, credential_id)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.name!.trim(),
          input.apiBase!.trim(),
          input.model!.trim(),
          input.protocol ?? 'anthropic',
          credentialId
        );
      return reply.code(201).send(toDto(getRow(Number(info.lastInsertRowid))!));
    });

    app.put('/api/providers/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const idNum = parseIdParam(id);
      if (!idNum) return reply.code(400).send({ message: 'id 必须是正整数' });
      const row = getRow(idNum);
      if (!row) return reply.code(404).send({ message: 'Provider 不存在' });
      const raw = (req.body ?? {}) as ProviderInput;
      // Same explicit extraction as POST (type-guarded, whitelist fields).
      const input: ProviderInput = {
        name: typeof raw.name === 'string' ? raw.name : undefined,
        apiBase: typeof raw.apiBase === 'string' ? raw.apiBase : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
        protocol: typeof raw.protocol === 'string' ? raw.protocol : undefined,
      };
      try {
        validate(input, true);
      } catch (err) {
        if (err instanceof ProviderError) return reply.code(err.statusCode).send({ message: err.message });
        throw err;
      }
      if (input.name && input.name.trim() !== row.name) {
        const dup = db.prepare('SELECT id FROM provider WHERE name = ?').get(input.name.trim());
        if (dup) return reply.code(409).send({ message: `Provider 名称 ${input.name} 已存在` });
      }

      let credentialId = row.credential_id;
      if (input.apiKey) {
        if (credentialId) credentials.update(credentialId, input.apiKey);
        else credentialId = credentials.store(`provider:${input.name ?? row.name}`, 'llm', input.apiKey);
      }

      db.prepare(
        `UPDATE provider SET name = ?, api_base = ?, model = ?, protocol = ?, credential_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      ).run(
        input.name?.trim() ?? row.name,
        input.apiBase?.trim() ?? row.api_base,
        input.model?.trim() ?? row.model,
        input.protocol ?? row.protocol ?? 'anthropic',
        credentialId,
        idNum
      );
      return toDto(getRow(idNum)!);
    });

    app.delete('/api/providers/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const idNum = parseIdParam(id);
      if (!idNum) return reply.code(400).send({ message: 'id 必须是正整数' });
      const row = getRow(idNum);
      if (!row) return reply.code(404).send({ message: 'Provider 不存在' });
      db.prepare('DELETE FROM provider WHERE id = ?').run(idNum);
      if (row.credential_id) credentials.delete(row.credential_id);
      if (defaultProviderId(db) === idNum) {
        db.prepare("DELETE FROM setting WHERE key = 'default_provider_id'").run();
      }
      return reply.code(204).send();
    });

    app.post('/api/providers/:id/default', async (req, reply) => {
      const { id } = req.params as { id: string };
      const idNum = parseIdParam(id);
      if (!idNum) return reply.code(400).send({ message: 'id 必须是正整数' });
      const row = getRow(idNum);
      if (!row) return reply.code(404).send({ message: 'Provider 不存在' });
      db.prepare(
        `INSERT INTO setting (key, value) VALUES ('default_provider_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(idNum));
      return toDto(getRow(idNum)!);
    });

    app.post('/api/providers/:id/test', async (req, reply) => {
      const { id } = req.params as { id: string };
      const idNum = parseIdParam(id);
      if (!idNum) return reply.code(400).send({ message: 'id 必须是正整数' });
      const row = getRow(idNum);
      if (!row) return reply.code(404).send({ message: 'Provider 不存在' });
      const key = row.credential_id ? credentials.reveal(row.credential_id) : null;

      const protocol = PROTOCOLS.includes(row.protocol as Protocol)
        ? (row.protocol as Protocol)
        : 'anthropic';
      const result = await testProvider(
        {
          name: row.name,
          apiBase: row.api_base,
          model: row.model,
          protocol,
          apiKey: key,
        },
        options.testOptions
      );
      // A failed test is a normal outcome (wrong key, unreachable host), so it
      // is reported in the body — a 502 here would make the console show a
      // generic request error instead of the diagnosis.
      return result;
    });
  };

  return { register };
}
