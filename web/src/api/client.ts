/**
 * Minimal API client. Auth is pluggable: the token is supplied by the
 * AuthProvider through `setAuthToken`, so swapping the auth layer (e.g. OA /
 * LDAP session cookie) does not touch page code.
 */

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    onUnauthorized?.();
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `请求失败（HTTP ${res.status}）`;
    const err = new Error(message) as ApiError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// --- domain types ----------------------------------------------------------

export interface Repo {
  id: number;
  type: 'svn' | 'git';
  name: string;
  url: string;
  username?: string;
  branch?: string;
  reviewConcurrency: number;
  /** Ordered model pool; empty = inherit the global default provider. */
  providerIds: number[];
  providerLabels: string[];
  enabled: boolean;
  hasCredential: boolean;
  /** Workspace prewarm state: pending/preparing = download in flight. */
  initStatus: 'pending' | 'preparing' | 'ready' | 'failed';
  initError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  repoId: number;
  node: string;
  trigger: 'manual' | 'auto';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  author?: string;
  /** Model bound at enqueue time ("name · model"); undefined for legacy rows. */
  providerLabel?: string;
  error?: string;
  ocrExitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

/** One selectable revision/commit in the trigger page's node picker. */
export interface RepoNode {
  /** SVN revision number or full git SHA. */
  node: string;
  author: string;
  date: string;
  message: string;
  files: string[];
}

/** One page of the node picker's history (cursor pagination, newest-first). */
export interface RepoNodePage {
  items: RepoNode[];
  /** Opaque cursor for the next (older) page; undefined when exhausted. */
  nextCursor?: string;
}

export interface TaskList {
  total: number;
  items: Task[];
}

export type ReviewVerdict = 'false_positive' | 'fixed' | 'wont_fix';

export interface ReportIssue {
  id: number;
  file: string | null;
  line: number | null;
  endLine?: number | null;
  severity: string | null;
  category?: string | null;
  description: string;
  suggestion?: string | null;
  suppressed?: boolean;
  suppressedBy?: number | null;
  feedback?: { verdict: ReviewVerdict; note: string | null };
}

export interface ReportDetail {
  report: {
    taskId: number;
    summary: string | null;
    issueCount: number;
    rawPath: string;
    parsedOk: boolean;
    engine?: string | null;
    createdAt: string;
  };
  issues: ReportIssue[];
  suppressedIssues?: ReportIssue[];
  raw?: string;
}

export interface TaskMemoryAudit {
  count: number;
  entries: { id: number; kind: string; title: string; scope: string | null; confidence: number }[];
}

export interface MonitorStatus {
  ruleId: number;
  repoId: number;
  enabled: boolean;
  intervalSeconds: number;
  lastNode: string | null;
  headNode: string | null;
  lastPollAt: string | null;
  lastPollError: string | null;
  initStatus: string;
  recentLog: {
    id: number;
    node: string;
    action: 'triggered' | 'skipped';
    reason: string | null;
    author: string | null;
    created_at: string;
  }[];
}

export interface MonitorRule {
  id: number;
  repoId: number;
  intervalSeconds: number;
  authorWhitelist: string[];
  pathPrefixes: string[];
  backtrackNodes: number;
  enabled: boolean;
  status: MonitorStatus | null;
}

export interface Provider {
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

export interface Channel {
  id: number;
  type: 'email' | 'chat';
  name: string;
  enabled: boolean;
  template: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationLog {
  id: number;
  taskId: number;
  channelId: number;
  channelName: string | null;
  channelType: string | null;
  status: 'sent' | 'failed';
  detail: string | null;
  createdAt: string;
}

export interface AuthStatus {
  mode: string;
  loginRequired: boolean;
  authenticated: boolean;
  username: string | null;
  displayName: string | null;
}

export interface DepInfo {
  command: string;
  found: boolean;
  executable: boolean;
  version?: string;
  error?: string;
  conditional: boolean;
  minVersion?: string;
  note?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  /** ISO timestamp. */
  t: string;
  level: LogLevel;
  /** Short source tag: server / ocr / task / monitor / notify ... */
  src: string;
  msg: string;
}

export interface LogQueryResult {
  total: number;
  items: LogLine[];
}

export interface LogFile {
  name: string;
  size: number;
  modified: string;
}

// --- engines / MCP / memory --------------------------------------------------

export interface EngineCapabilitiesDto {
  vcs: string[];
  revisionMode: 'single' | 'range';
  fullFileScan: boolean;
  mcp: 'config-inject' | 'none';
  memoryInjection: 'requirement' | 'none';
  resume: boolean;
  streaming: boolean;
  minVersion?: string;
}

export interface Engine {
  id: number;
  name: string;
  kind: string;
  enabled: boolean;
  isDefault: boolean;
  capabilities: EngineCapabilitiesDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServer {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  config: Record<string, unknown>;
  enabled: boolean;
  scope: 'global' | 'repo';
  repoId: number | null;
  toolAllowlist: string[] | null;
  timeoutSec: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpProbeResult {
  ok: boolean;
  stage?: 'start' | 'timeout' | 'protocol';
  error?: string;
  tools: string[];
}

export interface MemoryEntry {
  id: number;
  repoId: number;
  kind: 'architecture' | 'convention' | 'pitfall' | 'suppression' | 'history' | 'glossary';
  scope: string | null;
  title: string;
  body: string;
  confidence: number;
  hits: number;
  feedbackCount: number;
  status: 'active' | 'archived' | 'rejected';
  sourceTaskId: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface MemoryList {
  ftsAvailable: boolean;
  items: MemoryEntry[];
}

export interface TaskMcpAudit {
  servers: {
    serverId: number;
    serverName: string;
    allowlistEnforced: boolean;
    toolStats: Record<string, { calls: number; failures: number }> | null;
  }[];
  statsReported: boolean;
}

export interface FeedbackOutcome {
  feedbackId: number;
  memoryId: number | null;
  memoryAction: 'created' | 'reinforced' | 'none';
}
