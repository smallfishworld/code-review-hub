import type Database from 'better-sqlite3';
import { join } from 'node:path';
import type { CredentialService } from '../crypto/credentialService.js';
import type { TaskQueue } from '../tasks/taskQueue.js';
import { svnInfo, svnLog, type SvnLogEntry } from '../vcs/svn.js';
import { ensureGitClone, gitFetchBranch, gitLog, gitResolveSha, type GitLogEntry } from '../vcs/git.js';
import { repoSourceVersion, workspaceKey } from '../repos/sourceVersion.js';
import { evaluateFilters } from './filters.js';
import type { LogService } from '../logs/logService.js';

/**
 * Monitoring engine: polls SVN/Git repos on each rule's interval, detects new
 * nodes since the persisted position, applies author/path filters, and
 * enqueues review tasks.
 *
 * Design notes:
 * - One timer per enabled rule; ticks never overlap per rule (a slow poll
 *   skips the next tick rather than stacking).
 * - The processed position is persisted in monitor_state after each node, so
 *   a crash/restart resumes exactly where it stopped (spec: 重启恢复).
 * - Poll failures are recorded (last_poll_error) and the next tick retries;
 *   the position is not advanced, so no node is lost.
 * - Dedup: task UNIQUE(repo,node,trigger) + enqueueIfNew (any trigger) —
 *   a node reviewed manually is not re-reviewed by monitoring.
 */

export interface MonitorRuleRow {
  id: number;
  repo_id: number;
  interval_seconds: number;
  author_whitelist: string;
  path_prefixes: string;
  backtrack_nodes: number;
  enabled: number;
}

export interface MonitorStateRow {
  rule_id: number;
  last_node: string | null;
  head_node: string | null;
  last_poll_at: string | null;
  last_poll_error: string | null;
  init_status: string;
}

export interface MonitorLogRow {
  id: number;
  rule_id: number;
  node: string;
  action: 'triggered' | 'skipped';
  reason: string | null;
  author: string | null;
  created_at: string;
}

export interface MonitorStatus {
  ruleId: number;
  repoId: number;
  enabled: boolean;
  intervalSeconds: number;
  lastNode: string | null;
  /** Latest node on the remote as of the last poll (SVN HEAD / git branch head). */
  headNode: string | null;
  lastPollAt: string | null;
  lastPollError: string | null;
  initStatus: string;
  recentLog: MonitorLogRow[];
  nextPollAt?: string;
}

interface RepoRow {
  id: number;
  type: 'svn' | 'git';
  url: string;
  username: string | null;
  credential_id: number | null;
  branch: string | null;
  enabled: number;
  source_version: number;
}

export interface MonitorOptions {
  /** Base dir for clones (must match OcrRunner's dataDir). */
  dataDir: string;
  /** Clock injection for tests. */
  now?: () => number;
  /** Runtime log sink (web console); poll errors and triggers land here. */
  logs?: LogService;
}

export class MonitorService {
  private timers = new Map<number, NodeJS.Timeout>();
  private polling = new Set<number>();
  private stopped = false;

  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    private readonly queue: TaskQueue,
    private readonly opts: MonitorOptions
  ) {
    void this.opts.dataDir;
  }

  /** Start timers for all enabled rules (call at service startup). */
  start(): void {
    this.stopped = false;
    const rules = this.db
      .prepare(
        `SELECT r.* FROM monitor_rule r
         JOIN repo p ON p.id = r.repo_id
         WHERE r.enabled = 1 AND p.enabled = 1`
      )
      .all() as MonitorRuleRow[];
    for (const rule of rules) this.schedule(rule);
  }

  /** Stop all timers (shutdown / tests). */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  /**
   * Re-sync one rule's timer after its repo was enabled/disabled in the
   * console. Enabling a repo resumes its rule; disabling stops the timer.
   */
  syncRepo(repoId: number): void {
    const rule = this.db
      .prepare('SELECT * FROM monitor_rule WHERE repo_id = ?')
      .get(repoId) as MonitorRuleRow | undefined;
    if (!rule) {
      // The repo (and its rule) was deleted. Drop any timer still armed for
      // it: a surviving timer would fire against a missing rule and its error
      // path would try to write monitor_state for a dead rule_id.
      for (const ruleId of [...this.timers.keys()]) {
        const alive = this.db.prepare('SELECT 1 FROM monitor_rule WHERE id = ?').get(ruleId);
        if (!alive) this.unschedule(ruleId);
      }
      return;
    }
    if (rule.enabled === 1) this.schedule(rule);
    else this.unschedule(rule.id);
  }

  /** (Re)schedule a rule; no-op when disabled. */
  schedule(rule: MonitorRuleRow): void {
    this.unschedule(rule.id);
    if (!rule.enabled || this.stopped) return;
    // A disabled repo must not be polled: its rule keeps its config but the
    // timer stays off until the repo is enabled again.
    const repo = this.db
      .prepare('SELECT enabled FROM repo WHERE id = ?')
      .get(rule.repo_id) as { enabled: number } | undefined;
    if (repo && repo.enabled === 0) return;
    const intervalMs = Math.max(rule.interval_seconds, 30) * 1000;
    const timer = setInterval(() => {
      // A rejection escaping a timer callback is an unhandled rejection and
      // can terminate the process; pollRule already records its own errors.
      void this.pollRule(rule.id).catch(() => {});
    }, intervalMs);
    // don't hold the event loop open in tests/short-lived processes
    timer.unref?.();
    this.timers.set(rule.id, timer);
  }

  unschedule(ruleId: number): void {
    const t = this.timers.get(ruleId);
    if (t) clearInterval(t);
    this.timers.delete(ruleId);
  }

  /**
   * Enable a rule. On first enable (no persisted position) the start point is
   * the current HEAD, optionally backtracked by `backtrack_nodes`.
   */
  async enableRule(ruleId: number): Promise<void> {
    const rule = this.getRule(ruleId);
    const state = this.getState(ruleId);
    if (state?.last_node == null) {
      await this.initializePosition(rule, this.getRepo(rule.repo_id));
    }
    this.db.prepare('UPDATE monitor_rule SET enabled = 1 WHERE id = ?').run(ruleId);
    this.schedule({ ...rule, enabled: 1 });
  }

  disableRule(ruleId: number): void {
    this.db.prepare('UPDATE monitor_rule SET enabled = 0 WHERE id = ?').run(ruleId);
    this.unschedule(ruleId);
  }

  /** Poll one rule once (also used by tests). */
  async pollRule(ruleId: number): Promise<void> {
    if (this.polling.has(ruleId)) return; // previous tick still running
    this.polling.add(ruleId);
    let repo: RepoRow | undefined;
    try {
      // The rule (or its repo) may have been deleted since the timer was
      // armed. Stop the timer and return instead of throwing — an uncaught
      // throw in a timer callback terminates the process.
      const rule = this.db
        .prepare('SELECT * FROM monitor_rule WHERE id = ?')
        .get(ruleId) as MonitorRuleRow | undefined;
      if (!rule) {
        this.unschedule(ruleId);
        return;
      }
      if (!rule.enabled) return;
      repo = this.db
        .prepare('SELECT * FROM repo WHERE id = ?')
        .get(rule.repo_id) as RepoRow | undefined;
      if (!repo) {
        this.unschedule(ruleId);
        return;
      }
      if (repo.enabled === 0) return; // repo disabled in the console
      const state = this.getState(ruleId);
      if (state?.last_node == null) {
        // not initialized yet (e.g. enabled before start()); initialize now
        await this.initializePosition(rule, repo);
        return;
      }
      if (repo.type === 'svn') await this.pollSvn(rule, repo, state);
      else await this.pollGit(rule, repo, state);
    } catch (err) {
      if (repo && this.isCurrent(ruleId, repo)) this.recordPollError(ruleId, err);
    } finally {
      this.polling.delete(ruleId);
    }
  }

  /** Current monitoring status for the console panel. */
  status(ruleId?: number): MonitorStatus[] {
    const rules = (
      ruleId
        ? [this.getRule(ruleId)]
        : (this.db.prepare('SELECT * FROM monitor_rule ORDER BY id').all() as MonitorRuleRow[])
    ) as MonitorRuleRow[];
    return rules.map((rule) => {
      const state = this.getState(rule.id);
      const recentLog = this.db
        .prepare('SELECT * FROM monitor_log WHERE rule_id = ? ORDER BY id DESC LIMIT 20')
        .all(rule.id) as MonitorLogRow[];
      return {
        ruleId: rule.id,
        repoId: rule.repo_id,
        enabled: rule.enabled === 1,
        intervalSeconds: rule.interval_seconds,
        lastNode: state?.last_node ?? null,
        headNode: state?.head_node ?? null,
        lastPollAt: state?.last_poll_at ?? null,
        lastPollError: state?.last_poll_error ?? null,
        initStatus: state?.init_status ?? 'ready',
        recentLog,
      };
    });
  }

  // ---------------------------------------------------------------- internals

  private async initializePosition(rule: MonitorRuleRow, repo: RepoRow): Promise<void> {
    const auth = this.repoAuth(repo);
    try {
      if (repo.type === 'svn') {
        const info = await svnInfo(repo.url, auth);
        if (!this.isCurrent(rule.id, repo, false)) return;
        // No backtrack: start at HEAD (nothing historical is reviewed).
        // Backtrack N: position = HEAD-N so the first poll reviews the last N
        // revisions (from = position+1 = HEAD-N+1).
        const position =
          rule.backtrack_nodes > 0 ? Math.max(0, info.revision - rule.backtrack_nodes) : info.revision;
        this.setPosition(rule.id, String(position), 'ready');
        this.setHeadNode(rule.id, String(info.revision));
      } else {
        const wcDir = this.cloneDir(repo);
        this.setStateInit(rule.id, 'cloning');
        await ensureGitClone(wcDir, repo.url, auth);
        await gitFetchBranch(wcDir, repo.url, repo.branch ?? 'main', auth);
        const head = await gitResolveSha(wcDir, `origin/${repo.branch ?? 'main'}`);
        if (!head) throw new Error('无法解析远端分支最新提交');
        const start = rule.backtrack_nodes > 0
          // position = the commit just before the last N (exclusive range
          // start for `git log position..head`); '' = review from the root.
          ? await gitResolveSha(wcDir, `${head}~${rule.backtrack_nodes}`)
          : head;
        if (!this.isCurrent(rule.id, repo, false)) return;
        this.setHeadNode(rule.id, head);
        this.setPosition(rule.id, start ?? '', 'ready');
      }
    } catch (err) {
      if (this.isCurrent(rule.id, repo, false)) {
        this.setStateInit(rule.id, 'failed');
        this.recordPollError(rule.id, err);
      }
      throw err;
    }
  }

  private async pollSvn(
    rule: MonitorRuleRow,
    repo: RepoRow,
    state: MonitorStateRow
  ): Promise<void> {
    const auth = this.repoAuth(repo);
    const last = Number(state.last_node);
    const from = Number.isFinite(last) ? last + 1 : 1;
    const info = await svnInfo(repo.url, auth);
    if (!this.isCurrent(rule.id, repo)) return;
    this.setHeadNode(rule.id, String(info.revision));
    if (info.revision < from) {
      this.recordPollSuccess(rule.id, state.last_node);
      return; // nothing new
    }
    const entries = await svnLog(repo.url, from, 'HEAD', auth);
    if (!this.isCurrent(rule.id, repo)) return;
    for (const entry of entries) {
      this.processSvnNode(rule, entry, repo.source_version);
      this.setPosition(rule.id, String(entry.revision));
    }
    this.recordPollSuccess(rule.id, entries.at(-1)?.revision.toString() ?? state.last_node);
  }

  private async pollGit(
    rule: MonitorRuleRow,
    repo: RepoRow,
    state: MonitorStateRow
  ): Promise<void> {
    const wcDir = this.cloneDir(repo);
    const auth = this.repoAuth(repo);
    const branch = repo.branch ?? 'main';
    await ensureGitClone(wcDir, repo.url, auth);
    await gitFetchBranch(wcDir, repo.url, branch, auth);
    const head = await gitResolveSha(wcDir, `origin/${branch}`);
    if (!head) throw new Error(`无法解析 origin/${branch}`);
    if (!this.isCurrent(rule.id, repo)) return;
    this.setHeadNode(rule.id, head);
    const last = state.last_node ?? '';
    if (last === head) {
      this.recordPollSuccess(rule.id, last);
      return;
    }
    // `last` may be empty (backtracked to the very first commit) — then the
    // range is "everything reachable from head".
    const entries = await gitLog(wcDir, last, head);
    if (!this.isCurrent(rule.id, repo)) return;
    for (const entry of entries) {
      this.processGitNode(rule, entry, repo.source_version);
      this.setPosition(rule.id, entry.sha);
    }
    this.recordPollSuccess(rule.id, entries.at(-1)?.sha ?? head);
  }

  private processSvnNode(rule: MonitorRuleRow, entry: SvnLogEntry, sourceVersion: number): void {
    const outcome = evaluateFilters(this.parseRuleFilters(rule), {
      author: entry.author,
      paths: entry.paths.map((p) => p.path),
    });
    if (!outcome.matched) {
      this.logNode(rule.id, String(entry.revision), 'skipped', outcome.reason, entry.author);
      return;
    }
    const task = this.queue.enqueueIfNew(rule.repo_id, String(entry.revision), 'auto', entry.author, {
      sourceVersion, monitorRuleId: rule.id,
      commit: { message: entry.message, date: entry.date },
    });
    if (task) {
      this.logNode(rule.id, String(entry.revision), 'triggered', '命中监控规则', entry.author);
      this.opts.logs?.info(
        'monitor',
        `仓库 #${rule.repo_id} 新节点 r${entry.revision}（${entry.author}）命中监控规则，任务 #${task.id} 已排队`
      );
    } else {
      this.logNode(
        rule.id,
        String(entry.revision),
        'skipped',
        '该节点已评审过（去重）',
        entry.author
      );
    }
  }

  private processGitNode(rule: MonitorRuleRow, entry: GitLogEntry, sourceVersion: number): void {
    const outcome = evaluateFilters(this.parseRuleFilters(rule), {
      author: entry.authorName,
      paths: entry.files,
    });
    if (!outcome.matched) {
      this.logNode(rule.id, entry.sha, 'skipped', outcome.reason, entry.authorName);
      return;
    }
    const task = this.queue.enqueueIfNew(rule.repo_id, entry.sha, 'auto', entry.authorName, {
      sourceVersion, monitorRuleId: rule.id,
      commit: { message: entry.message, date: entry.date },
    });
    if (task) {
      this.logNode(rule.id, entry.sha, 'triggered', '命中监控规则', entry.authorName);
      this.opts.logs?.info(
        'monitor',
        `仓库 #${rule.repo_id} 新节点 ${entry.sha.slice(0, 10)}（${entry.authorName}）命中监控规则，任务 #${task.id} 已排队`
      );
    } else {
      this.logNode(rule.id, entry.sha, 'skipped', '该节点已评审过（去重）', entry.authorName);
    }
  }

  private parseRuleFilters(rule: MonitorRuleRow): {
    authorWhitelist: string[];
    pathPrefixes: string[];
  } {
    return {
      authorWhitelist: safeJsonArray(rule.author_whitelist),
      pathPrefixes: safeJsonArray(rule.path_prefixes),
    };
  }

  private logNode(
    ruleId: number,
    node: string,
    action: 'triggered' | 'skipped',
    reason: string | null,
    author: string | null
  ): void {
    this.db
      .prepare(
        'INSERT INTO monitor_log (rule_id, node, action, reason, author) VALUES (?, ?, ?, ?, ?)'
      )
      .run(ruleId, node, action, reason, author);
  }

  private recordPollSuccess(ruleId: number, lastNode: string | null): void {
    this.db
      .prepare(
        `UPDATE monitor_state
         SET last_poll_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_poll_error = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE rule_id = ?`
      )
      .run(ruleId);
    void lastNode;
  }

  private recordPollError(ruleId: number, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.opts.logs?.error('monitor', `监控规则 #${ruleId} 轮询失败: ${message}`);
    // monitor_state.rule_id is a foreign key to monitor_rule. A rule deleted
    // mid-poll leaves nothing to record against, and letting the FK violation
    // escape would take down the process from a timer callback.
    const alive = this.db.prepare('SELECT 1 FROM monitor_rule WHERE id = ?').get(ruleId);
    if (!alive) return;
    this.db
      .prepare(
        `INSERT INTO monitor_state (rule_id, last_poll_at, last_poll_error)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           last_poll_at = excluded.last_poll_at,
           last_poll_error = excluded.last_poll_error,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ruleId, message.slice(0, 2000));
  }

  private setPosition(ruleId: number, node: string, initStatus = 'ready'): void {
    this.db
      .prepare(
        `INSERT INTO monitor_state (rule_id, last_node, init_status)
         VALUES (?, ?, ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           last_node = excluded.last_node,
           init_status = excluded.init_status,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ruleId, node, initStatus);
  }

  private setHeadNode(ruleId: number, node: string): void {
    this.db
      .prepare(
        `INSERT INTO monitor_state (rule_id, head_node) VALUES (?, ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           head_node = excluded.head_node,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ruleId, node);
  }

  private setStateInit(ruleId: number, initStatus: string): void {
    this.db
      .prepare(
        `INSERT INTO monitor_state (rule_id, init_status) VALUES (?, ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           init_status = excluded.init_status,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ruleId, initStatus);
  }

  private getRule(ruleId: number): MonitorRuleRow {
    const row = this.db.prepare('SELECT * FROM monitor_rule WHERE id = ?').get(ruleId) as
      | MonitorRuleRow
      | undefined;
    if (!row) throw new Error(`监控规则 ${ruleId} 不存在`);
    return row;
  }

  private getState(ruleId: number): MonitorStateRow | undefined {
    return this.db.prepare('SELECT * FROM monitor_state WHERE rule_id = ?').get(ruleId) as
      | MonitorStateRow
      | undefined;
  }

  private getRepo(repoId: number): RepoRow {
    const row = this.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId) as
      | RepoRow
      | undefined;
    if (!row) throw new Error(`仓库 ${repoId} 不存在`);
    return row;
  }

  private repoAuth(repo: RepoRow): { username?: string; password?: string } {
    return {
      username: repo.username ?? undefined,
      password: repo.credential_id
        ? (this.credentials.reveal(repo.credential_id) ?? undefined)
        : undefined,
    };
  }

  private isCurrent(ruleId: number, repo: RepoRow, requireEnabled = true): boolean {
    if (this.stopped || repoSourceVersion(this.db, repo.id) !== repo.source_version) return false;
    const rule = this.db.prepare(
      'SELECT r.enabled AS rule_enabled, p.enabled AS repo_enabled FROM monitor_rule r JOIN repo p ON p.id = r.repo_id WHERE r.id = ?'
    ).get(ruleId) as { rule_enabled: number; repo_enabled: number } | undefined;
    return Boolean(rule && (!requireEnabled || (rule.rule_enabled && rule.repo_enabled)));
  }

  private cloneDir(repo: RepoRow): string {
    return join(this.opts.dataDir, 'workcopies', workspaceKey(repo.id, repo.source_version));
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
