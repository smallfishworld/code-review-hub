import type { TaskRecord } from '../tasks/taskQueue.js';

/**
 * Pluggable review engine abstraction (openspec: pluggable-engines-mcp-memory).
 *
 * The task queue depends only on this interface; `ocr` is the first adapter
 * (engines/ocrEngine.ts). Future adapters (claude-code, codex, custom-http,
 * custom-script) implement the same contract; capabilities are static
 * compile-time constants of each adapter — they describe what the adapter
 * CODE can do, so they never live in user-configurable DB rows.
 */

/** VCS types an engine can review. */
export type EngineVcs = 'svn' | 'git';

/** How the engine consumes MCP servers (see mcp-integration spec). */
export type EngineMcpMode = 'config-inject' | 'none';

/** How pre-review memory/context is fed to the engine. */
export type EngineMemoryMode = 'requirement' | 'none';

export interface EngineCapabilities {
  vcs: EngineVcs[];
  /** 'single' = one revision per task; 'range' = native range support. */
  revisionMode: 'single' | 'range';
  /** Engine reads surrounding full files, not just the diff. */
  fullFileScan: boolean;
  mcp: EngineMcpMode;
  memoryInjection: EngineMemoryMode;
  resume: boolean;
  streaming: boolean;
  /** Minimum runtime version for MCP / memory features (ocr >= 1.13). */
  minVersion?: string;
}

/** Probe result: dependency check + runtime capability gating. */
export interface EngineProbe {
  ok: boolean;
  version?: string;
  /**
   * Features degraded at runtime (e.g. ocr < 1.13 -> ['mcp','memory']).
   * Static capabilities stay; the executor skips the corresponding steps.
   */
  degraded: string[];
  error?: string;
}

/** Static per-task inputs for prepare(). */
export interface PrepareContext {
  task: TaskRecord;
  /** Repo auth resolved from the DB (plaintext password, in-memory only). */
  auth: {
    type: 'svn' | 'git';
    url: string;
    username?: string;
    password?: string;
    branch?: string;
  };
  /** Kill handle wiring for task cancellation. */
  onSpawn: (child: { kill: (signal?: string) => void }) => void;
  /** Environment overrides pointing engines at their isolated HOME. */
  env?: Record<string, string>;
}

/** Change-set collected by prepare(): the retrieval input for memory. */
export interface PrepareResult {
  /** Changed file paths (repo-relative, forward slashes). */
  changedFiles: string[];
  /** Sampled identifiers from added lines / file names, for FTS matching. */
  identifiers: string[];
}

/** Review request handed to review(). */
export interface ReviewRequest {
  task: TaskRecord;
  reportPath: string;
  /** Rendered memory context (empty when nothing matched / feature off). */
  requirementText?: string;
  /** MCP servers to inject, already resolved for this repo (engine-format). */
  mcpServers?: Record<string, unknown>;
  /** Runtime degradations from probe() (skip --requirement / mcp config). */
  degraded?: string[];
}

export interface EngineRawResult {
  exitCode: number;
  error?: string;
}

/**
 * Normalized issue — the unified report model every engine maps to
 * (start line required when known, end line optional).
 */
export interface NormalizedIssue {
  file?: string;
  startLine?: number;
  endLine?: number;
  severity?: string;
  category?: string;
  description: string;
  suggestion?: string;
}

export interface ReviewEngine {
  readonly engineId: number;
  readonly name: string;
  readonly capabilities: EngineCapabilities;
  /** Dependency + version check; cheap, safe to call per task. */
  probe(): Promise<EngineProbe>;
  /** Bring the working copy to the task node and collect the change set. */
  prepare(ctx: PrepareContext): Promise<PrepareResult>;
  /** Execute the review; resolves non-throwingly on engine failure. */
  review(req: ReviewRequest, ctx: PrepareContext): Promise<EngineRawResult>;
  /** Map the engine's raw JSON output to the unified issue model. */
  normalize(raw: string): { issues: NormalizedIssue[] };
}
