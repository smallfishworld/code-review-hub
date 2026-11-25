import { runCapture } from '../providers/providerTester.js';
import type Database from 'better-sqlite3';

/**
 * MCP connectivity test (openspec mcp-integration spec / task 4.3).
 *
 * stdio: spawn `command args...` (via the shared runCapture plumbing), write
 * a pipelined MCP handshake (initialize -> initialized -> tools/list) as
 * newline-delimited JSON to stdin, close stdin, and parse the JSON-RPC
 * responses from stdout. Servers that exit on EOF resolve quickly; ones that
 * linger are reaped by the timeout kill and their captured output is parsed
 * all the same.
 *
 * http: POST initialize then tools/list per Streamable HTTP (Accept declares
 * both application/json and text/event-stream; SSE frames are unwrapped).
 *
 * The test never mutates registry data.
 */

const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpProbeResult {
  ok: boolean;
  /** Failure stage: start | timeout | protocol — matches the spec scenario. */
  stage?: 'start' | 'timeout' | 'protocol';
  error?: string;
  tools: string[];
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { tools?: { name?: unknown }[] };
  error?: { message?: string };
}

export async function probeMcpServer(
  db: Database.Database,
  serverId: number,
  timeoutSecOverride?: number
): Promise<McpProbeResult> {
  const row = db
    .prepare('SELECT * FROM mcp_server WHERE id = ?')
    .get(serverId) as
    | {
        id: number;
        name: string;
        transport: 'stdio' | 'http';
        config: string;
        tool_allowlist: string | null;
        timeout_sec: number;
      }
    | undefined;
  if (!row) {
    return { ok: false, stage: 'protocol', error: 'MCP 服务器不存在', tools: [] };
  }
  const config = JSON.parse(row.config) as Record<string, unknown>;
  const timeoutMs = (timeoutSecOverride ?? row.timeout_sec ?? 10) * 1000;
  return row.transport === 'stdio'
    ? probeStdio(config, timeoutMs)
    : probeHttp(config, timeoutMs);
}

function jsonRpcLine(id: number, method: string, params?: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`;
}

/** stdio probe: pipelined handshake over newline-delimited JSON. */
async function probeStdio(config: Record<string, unknown>, timeoutMs: number): Promise<McpProbeResult> {
  const command = typeof config.command === 'string' ? config.command : '';
  if (!command) return { ok: false, stage: 'protocol', error: '配置缺少 command', tools: [] };
  const args = Array.isArray(config.args) ? (config.args as string[]) : [];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...((config.env as Record<string, string>) ?? {}),
  };
  const input =
    jsonRpcLine(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'code-review-hub', version: '1.0' },
    }) +
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
    jsonRpcLine(2, 'tools/list', {});

  const res = await runCapture(command, args, { env, timeoutMs, input });
  if (res.output.includes('（测试超时）') || /timed out/i.test(res.output)) {
    // fall through: output may still contain a complete tools/list answer
  }
  const parsed = parseProbeOutput(res.output);
  if (parsed.tools.length > 0) return { ok: true, tools: parsed.tools };
  if (parsed.serverError) {
    return { ok: false, stage: 'protocol', error: parsed.serverError, tools: [] };
  }
  if (res.code === null && /failed to start|ENOENT|spawn/i.test(res.output)) {
    return { ok: false, stage: 'start', error: res.output.trim().slice(0, 400), tools: [] };
  }
  if (/测试超时|timed out/i.test(res.output) || res.code === null) {
    return { ok: false, stage: 'timeout', error: `进程在超时内未完成握手（${timeoutMs}ms）`, tools: [] };
  }
  return {
    ok: false,
    stage: 'protocol',
    error: `协议错误：未收到 tools/list 响应（退出码 ${res.code}）${res.output.slice(0, 200)}`,
    tools: [],
  };
}

/** Parse JSON-RPC objects out of mixed stdout output. */
function parseProbeOutput(output: string): { tools: string[]; serverError?: string } {
  const tools: string[] = [];
  let serverError: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      continue;
    }
    if (msg.error) {
      serverError = msg.error.message ?? '服务器返回错误';
      continue;
    }
    if (Array.isArray(msg.result?.tools)) {
      for (const t of msg.result!.tools!) {
        if (t && typeof t.name === 'string') tools.push(t.name);
      }
    }
  }
  return { tools, serverError };
}

/** http probe: initialize + tools/list over Streamable HTTP. */
async function probeHttp(config: Record<string, unknown>, timeoutMs: number): Promise<McpProbeResult> {
  const url = typeof config.url === 'string' ? config.url : '';
  if (!url) return { ok: false, stage: 'protocol', error: '配置缺少 url', tools: [] };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...((config.headers as Record<string, string>) ?? {}),
  };
  const call = async (body: unknown): Promise<JsonRpcResponse> => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }
    const text = await res.text();
    return parseHttpRpc(text);
  };

  try {
    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'code-review-hub', version: '1.0' },
      },
    });
    if (init.error) {
      return { ok: false, stage: 'protocol', error: `initialize 失败: ${init.error.message}`, tools: [] };
    }
    // session header for stateful servers (Mcp-Session-Id) is best-effort;
    // stateless servers ignore it.
    const toolsRes = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (toolsRes.error) {
      return {
        ok: false,
        stage: 'protocol',
        error: `initialize 成功但 tools/list 失败: ${toolsRes.error.message}`,
        tools: [],
      };
    }
    const tools = (toolsRes.result?.tools ?? [])
      .map((t) => (typeof t.name === 'string' ? t.name : ''))
      .filter(Boolean);
    return { ok: true, tools };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stage = /timeout|abort/i.test(msg) ? 'timeout' : 'start';
    return { ok: false, stage, error: msg, tools: [] };
  }
}

/** Accept either a bare JSON-RPC body or an SSE stream wrapping one. */
function parseHttpRpc(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  // text/event-stream: take the data: payload of the last event
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  throw new Error('响应既不是 JSON 也不是 SSE 数据帧');
}
