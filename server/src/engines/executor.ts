import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import type { LogService } from '../logs/logService.js';
import type { TaskRecord } from '../tasks/taskQueue.js';
import { loadRepoAuth } from '../tasks/ocrRunner.js';
import { createEngine, type EngineRow } from './registry.js';
import { resolveEngineForRepo, EngineResolveError } from './resolver.js';
import type { PrepareResult, ReviewEngine } from './types.js';
import { collectEffectiveServers, buildOcrMcpServers, recordMcpInjection } from '../mcp/injector.js';
import { MemoryStore } from '../memory/store.js';
import { MemoryRetrieval } from '../memory/retrieval.js';
import { renderMemoryContext, recordMemoryInjection } from '../memory/inject.js';
import { runArchivalScan, bumpReviewCount, runCompaction } from '../memory/evolve.js';

/**
 * The TaskQueue executor backed by the pluggable engine pipeline:
 *
 *   resolve engine (rule -> repo -> default) -> probe (version gating)
 *   -> prepare (workspace + change collection)
 *   -> memory retrieval + injection audit (engine must support it)
 *   -> MCP collect + config-inject (engine must support it)
 *   -> review -> review-count bookkeeping (compaction trigger)
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
    onSpawn: (child: { kill: (signal?: string) => void }) => void
  ): Promise<{ exitCode: number; error?: string }> => {
    let engine: ReviewEngine;
    let row: EngineRow;
    try {
      const resolved = resolveEngineForRepo(this.db, task.repoId);
      row = resolved.row;
      engine = createEngine(row, this.db, this.credentials, this.opts);
    } catch (err) {
      const msg = err instanceof EngineResolveError ? err.message : String(err);
      this.opts.logs?.error('task', `#${task.id} 引擎解析失败: ${msg}`);
      return { exitCode: -1, error: msg };
    }
    this.db.prepare('UPDATE task SET engine_id = ? WHERE id = ?').run(row.id, task.id);

    const probe = await engine.probe();
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

    const auth = loadRepoAuth(this.db, this.credentials, task.repoId);
    let changes: PrepareResult;
    try {
      changes = await engine.prepare({ task, auth, onSpawn });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: -1, error: msg };
    }

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
        const servers = collectEffectiveServers(this.db, task.repoId);
        if (servers.length > 0) {
          mcpServers = buildOcrMcpServers(servers);
          recordMcpInjection(this.db, task.id, servers);
          this.opts.logs?.info('task', `#${task.id} 注入 ${servers.length} 个 MCP 服务器`);
        }
      }
    } catch (err) {
      this.opts.logs?.info('task', `#${task.id} MCP 注入失败（不影响评审）: ${String(err)}`);
    }

    const result = await engine.review(
      { task, reportPath: '', requirementText, mcpServers, degraded: probe.degraded },
      { task, auth, onSpawn }
    );

    if (result.exitCode === 0) {
      try {
        bumpReviewCount(this.db, task.repoId);
        runCompaction(this.db, this.memory, task.repoId);
      } catch {
        // 演化记账失败不影响任务结果
      }
    }
    return { exitCode: result.exitCode, error: result.error };
  };
}
