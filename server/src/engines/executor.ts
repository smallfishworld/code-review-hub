import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialService } from '../crypto/credentialService.js';
import type { LogService } from '../logs/logService.js';
import type { TaskExecutionResult, TaskRecord, TaskSpawnHandler } from '../tasks/taskQueue.js';
import { loadRepoAuth } from '../tasks/ocrRunner.js';
import { createEngine, getEngineRow, type EngineRow } from './registry.js';
import { resolveEngineForRepo, EngineResolveError } from './resolver.js';
import type { PrepareContext, PrepareResult, ReviewEngine } from './types.js';
import { collectEffectiveServers, buildOcrMcpServers, isBuiltinCodeGraph, recordMcpInjection } from '../mcp/injector.js';
import { prepareReviewCodeGraph } from '../mcp/codeGraph.js';
import { MemoryStore } from '../memory/store.js';
import { MemoryRetrieval } from '../memory/retrieval.js';
import { renderMemoryContext, recordMemoryInjection } from '../memory/inject.js';
import { runArchivalScan } from '../memory/evolve.js';

/**
 * The TaskQueue executor backed by the pluggable engine pipeline:
 *
 *   resolve engine (rule -> repo -> default) -> probe (version gating)
 *   -> prepare (workspace + change collection)
 *   -> memory retrieval + injection audit (engine must support it)
 *   -> MCP collect + config-inject (engine must support it)
 *   -> review -> validate and normalize its report
 *
 * All auxiliary steps (memory/MCP) are best-effort: they never turn a working
 * review into a failed task (spec: 记忆为空或引擎不支持 / 不支持 MCP 的引擎).
 */
export class EngineExecutor {
  private readonly memory: MemoryStore;

  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    private readonly opts: { dataDir: string; logs?: LogService }
  ) {
    this.memory = new MemoryStore(db, opts.dataDir);
  }

  /** Executor callback for TaskQueue. */
  execute = async (
    task: TaskRecord,
    onSpawn: TaskSpawnHandler,
    signal: AbortSignal
  ): Promise<TaskExecutionResult> => {
    signal.throwIfAborted();
    const auth = loadRepoAuth(this.db, this.credentials, task.repoId, task.sourceVersion);
    let engine: ReviewEngine;
    let row: EngineRow;
    try {
      if (task.engineSelectionError) throw new EngineResolveError(task.engineSelectionError);
      if (task.engineId === undefined) {
        // Tasks queued before provenance was persisted use repo/default selection.
        row = resolveEngineForRepo(this.db, task.repoId, task.monitorRuleId).row;
        this.db.prepare('UPDATE task SET engine_id = ? WHERE id = ?').run(row.id, task.id);
      } else {
        const selected = getEngineRow(this.db, task.engineId);
        if (!selected) throw new EngineResolveError(`评审引擎 #${task.engineId} 不存在`);
        if (!selected.enabled) throw new EngineResolveError(`评审引擎 ${selected.name} 已停用`);
        row = selected;
      }
      engine = createEngine(row, this.db, this.credentials, this.opts);
    } catch (err) {
      const msg = err instanceof EngineResolveError ? err.message : String(err);
      this.opts.logs?.error('task', `#${task.id} 引擎解析失败: ${msg}`);
      return { exitCode: -1, error: msg };
    }
    if (!engine.capabilities.vcs.includes(auth.type)) {
      return { exitCode: -1, error: `引擎 ${engine.name} 不支持 ${auth.type} 仓库` };
    }
    const probe = await engine.probe(signal);
    signal.throwIfAborted();
    if (!probe.ok) {
      const msg = `引擎 ${row.name} 不可用: ${probe.error ?? '未知原因'}`;
      this.opts.logs?.error('task', `#${task.id} ${msg}`);
      return { exitCode: -1, error: msg };
    }
    if (probe.degraded.length > 0) {
      this.opts.logs?.info(
        'task',
        `#${task.id} 引擎 ${row.name} 版本过低，降级跳过: ${probe.degraded.join(', ')}`
      );
    }

    const context: PrepareContext = { task, auth, onSpawn, signal };
    let changes: PrepareResult;
    try {
      changes = await engine.prepare(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: -1, error: msg };
    }
    signal.throwIfAborted();

    // 记忆检索注入（引擎支持且未被版本降级时）
    let requirementText: string | undefined;
    try {
      if (engine.capabilities.memoryInjection !== 'none' && !probe.degraded.includes('memory')) {
        runArchivalScan(this.memory, task.repoId); // 顺带演化：归档扫描
        const retrieval = new MemoryRetrieval(this.memory, this.db);
        const entries = retrieval.retrieve(task.repoId, changes);
        requirementText = renderMemoryContext(entries);
        if (entries.length > 0) {
          recordMemoryInjection(this.db, task.id, entries);
          this.memory.markUsed(entries.map((e) => e.id));
          this.opts.logs?.info('task', `#${task.id} 注入 ${entries.length} 条项目记忆`);
        }
      }
    } catch (err) {
      this.opts.logs?.info('task', `#${task.id} 记忆注入失败（不影响评审）: ${String(err)}`);
    }

    // MCP 注入（config-inject 能力 + 未被版本降级时）
    let mcpServers: Record<string, unknown> | undefined;
    try {
      if (engine.capabilities.mcp === 'config-inject' && !probe.degraded.includes('mcp')) {
        let servers = collectEffectiveServers(this.db, task.repoId);
        let codeGraphArgs: [string, string] | undefined;
        if (servers.some(isBuiltinCodeGraph)) {
          try {
            if (!changes.workspacePath) throw new Error('引擎未提供本地工作副本');
            codeGraphArgs = await prepareReviewCodeGraph(this.opts.dataDir, task, changes.workspacePath, signal);
          } catch (err) {
            signal.throwIfAborted();
            servers = servers.filter((server) => !isBuiltinCodeGraph(server));
            const reason = err instanceof Error ? err.message.trim().split('\n').at(-1) : String(err);
            this.opts.logs?.warn('task', `#${task.id} CodeGraph 索引未就绪，本次跳过: ${reason}`);
          }
        }
        if (servers.length > 0) {
          mcpServers = buildOcrMcpServers(servers, {
            dataDir: this.opts.dataDir,
            repoId: task.repoId,
            codeGraphArgs,
          });
          recordMcpInjection(this.db, task.id, servers);
          this.opts.logs?.info('task', `#${task.id} 注入 ${servers.length} 个 MCP 服务器`);
        }
      }
    } catch (err) {
      this.opts.logs?.info('task', `#${task.id} MCP 注入失败（不影响评审）: ${String(err)}`);
    }

    signal.throwIfAborted();
    const reportsDir = join(this.opts.dataDir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const stagingDir = mkdtempSync(join(reportsDir, `.${task.id}-`));
    const reportPath = join(stagingDir, 'report.json');
    try {
      const result = await engine.review(
        { task, reportPath, requirementText, mcpServers, degraded: probe.degraded },
        context
      );
      signal.throwIfAborted();
      if (result.exitCode !== 0) return result;
      try {
        const normalized = engine.normalize(readFileSync(reportPath, 'utf8'));
        const rawPath = join(reportsDir, `${task.id}.json`);
        renameSync(reportPath, rawPath);
        return { exitCode: 0, report: { rawPath, engineName: engine.name, ...normalized } };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { exitCode: -1, error: `评审报告无效: ${reason}` };
      }
    } finally {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch (err) {
        this.opts.logs?.warn('task', `#${task.id} 清理报告临时目录失败: ${String(err)}`);
      }
    }
  };
}
