import { spawn } from 'node:child_process';
import { bindProcessAbort } from '../vcs/processAbort.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which } from '../deps/which.js';
import { prepareOcrHome, type OcrProviderSettings, type Protocol } from './ocrProviderConfig.js';

/**
 * Provider connectivity test.
 *
 * The old probe hit `${apiBase}/models`, which is not what a review calls and
 * which many gateways do not implement — a correctly configured provider could
 * report failure while a broken one reported success. This module instead
 * exercises the same path a review takes:
 *
 * 1. Preferred: run `ocr llm test` with an isolated HOME whose
 *    `.opencodereview/config.json` is generated from the provider row. That
 *    validates URL normalisation, auth header, protocol and model name exactly
 *    as a real review will.
 * 2. Fallback (ocr not installed): POST a minimal message to the protocol's
 *    real chat endpoint, using the same URL normalisation ocr applies.
 */

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  /** Which path produced the verdict, so the UI can explain a degraded test. */
  via: 'ocr' | 'http';
}

/** ocr appends this to the configured base URL, per protocol. */
const CHAT_PATH: Record<Exclude<Protocol, 'anthropic-bedrock'>, string> = {
  anthropic: '/messages',
  openai: '/chat/completions',
  'openai-responses': '/responses',
};

/**
 * Resolve the endpoint ocr will actually POST to. Mirrors ocr's own
 * normalisation: keep an explicit `/v1` (or a full endpoint), otherwise add
 * `/v1` before the protocol's path.
 */
export function chatEndpoint(apiBase: string, protocol: Protocol): string {
  if (protocol === 'anthropic-bedrock') return apiBase;
  const suffix = CHAT_PATH[protocol];
  const base = apiBase.trim().replace(/\/+$/, '');
  if (base.endsWith(suffix)) return base;
  if (/\/v\d+(?:beta\d*)?$/.test(base)) return base + suffix;
  return `${base}/v1${suffix}`;
}

/** A minimal request body that costs one token but proves model + auth work. */
function probeBody(model: string, protocol: Protocol): unknown {
  if (protocol === 'openai-responses') {
    return { model, input: 'ping', max_output_tokens: 16 };
  }
  return { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
}

function probeHeaders(apiKey: string, protocol: Protocol): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Pull the most useful line out of an error body without dumping HTML. */
function summarizeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed.error;
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    if (typeof err === 'string') return err;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // not JSON (HTML error page, proxy notice) — fall through
  }
  return trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 300);
}

/** Direct HTTP probe against the protocol's real chat endpoint. */
export async function probeHttp(
  settings: OcrProviderSettings,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ProviderTestResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = chatEndpoint(settings.apiBase, settings.protocol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: probeHeaders(settings.apiKey ?? '', settings.protocol),
      body: JSON.stringify(probeBody(settings.model, settings.protocol)),
      signal: controller.signal,
    });
    if (res.ok) {
      return { ok: true, message: `连接成功：${url} 已接受模型 ${settings.model}`, via: 'http' };
    }
    const detail = summarizeBody(await res.text());
    const hint =
      res.status === 401 || res.status === 403
        ? '（API Key 无效或无权限）'
        : res.status === 404
          ? '（接口地址不存在，请检查 API 地址是否包含正确的路径前缀）'
          : res.status === 400 && /model/i.test(detail)
            ? '（模型名可能不被该服务支持）'
            : '';
    return {
      ok: false,
      message: `连接失败：HTTP ${res.status}${hint}${detail ? ` — ${detail}` : ''}`,
      via: 'http',
    };
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '请求超时'
          : err.message
        : String(err);
    return { ok: false, message: `连接失败：${reason}（${url}）`, via: 'http' };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `ocr llm test` against an isolated HOME built from this provider. */
async function probeWithOcr(
  settings: OcrProviderSettings,
  opts: { timeoutMs?: number; ocrBin?: string }
): Promise<ProviderTestResult | null> {
  const ocrBin = opts.ocrBin ?? (await which('ocr'));
  if (!ocrBin) return null;

  // A throwaway HOME: the review runner owns `<dataDir>/ocr-home`, and
  // rewriting it here would corrupt a review that is running right now.
  const home = mkdtempSync(join(tmpdir(), 'crp-llmtest-'));
  try {
    const prepared = prepareOcrHome(home, settings, join(home, 'ocr-home'));
    const env: Record<string, string> = {
      ...(process.env as unknown as Record<string, string>),
      ...(prepared?.env ?? {}),
    };
    const { code, output } = await runCapture(ocrBin, ['llm', 'test'], {
      env,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
    const text = output.trim();
    if (code === 0) {
      return { ok: true, message: `连接成功：ocr 已用模型 ${settings.model} 完成一次测试对话`, via: 'ocr' };
    }
    // ocr prints "Error: llm request failed: ..." — keep the cause, drop the prefix.
    const detail = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^Error:\s*/i, '').replace(/^llm request failed:\s*/i, ''))
      .join(' ');
    const hint = /401|403|unauthorized|invalid.*key|authentication/i.test(detail)
      ? '（API Key 无效或无权限）'
      : /404|not found/i.test(detail)
        ? '（接口地址不存在，请检查 API 地址）'
        : /model/i.test(detail) && /not|unsupported|invalid/i.test(detail)
          ? '（模型名可能不被该服务支持）'
          : '';
    return {
      ok: false,
      message: `连接失败${hint}${detail ? `：${detail.slice(0, 400)}` : `（ocr 退出码 ${code}）`}`,
      via: 'ocr',
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Spawn a command, capturing stdout+stderr, with a hard timeout. */
export function runCapture(
  command: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number; input?: string; signal?: AbortSignal }
): Promise<{ code: number | null; output: string }> {
  opts.signal?.throwIfAborted();
  // Windows cannot spawn npm's `ocr.cmd` shim without a shell (EINVAL), and
  // the shim is what `which('ocr')` resolves to there. Same handling as the
  // review runner: shell only for a .cmd/.bat on win32.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: opts.env,
      windowsHide: true,
      shell: needsShell,
      detached: Boolean(opts.signal) && process.platform !== 'win32',
    });
    const unbind = bindProcessAbort(child, opts.signal);
    let output = '';
    let settled = false;
    // Optional pipelined stdin (used by the MCP stdio probe): write the
    // request batch, then close stdin so well-behaved servers exit after
    // answering instead of hanging until the timeout kill.
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unbind();
      resolve({ code, output });
    };
    // On Windows a timed-out shell shim only kills cmd.exe and the real ocr
    // keeps running, holding the pipes open; kill the whole tree like the
    // review runner does. The PID travels via a sanitized environment
    // variable (argv stays fully static; PowerShell expands it as data).
    const killTree = () => {
      if (process.platform === 'win32') {
        const pid = child.pid;
        const pidToken =
          typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && /^\d+$/.test(String(pid))
            ? String(pid)
            : null;
        if (pidToken !== null) {
          spawn(
            'powershell',
            ['-NoProfile', '-Command', 'taskkill /PID $env:CRP_PID /T /F'],
            { windowsHide: true, env: { ...process.env, CRP_PID: pidToken } }
          );
        }
      } else {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      killTree();
      output += '\n（测试超时）';
      finish(null);
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString('utf8');
    });
    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Test one provider. Bedrock is reported as untestable here: it authenticates
 * with AWS SigV4 credentials this endpoint does not hold, so a probe would
 * always fail for a correctly configured provider.
 */
export async function testProvider(
  settings: OcrProviderSettings,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; ocrBin?: string } = {}
): Promise<ProviderTestResult> {
  if (settings.protocol === 'anthropic-bedrock') {
    return {
      ok: true,
      message: 'AWS Bedrock 使用 AWS 签名鉴权，无法在此探测；配置将在评审时由 ocr 校验',
      via: 'ocr',
    };
  }
  if (!settings.apiKey) {
    return { ok: false, message: '该 Provider 未配置 API Key', via: 'http' };
  }
  const viaOcr = await probeWithOcr(settings, opts);
  if (viaOcr) return viaOcr;
  const direct = await probeHttp(settings, opts);
  return {
    ...direct,
    message: `${direct.message}（未检测到 ocr，已改用直连探测）`,
  };
}
