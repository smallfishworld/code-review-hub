import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import type { TaskQueue, TaskRecord } from './taskQueue.js';
import { svnInfo, svnLog } from '../vcs/svn.js';
import { ensureGitClone, gitFetchBranch, gitLog, gitResolveSha } from '../vcs/git.js';
import { repoSourceVersion } from '../repos/sourceVersion.js';
import { workCopyDir } from './ocrRunner.js';

/**
 * Manual review triggering: single node (SVN revision / Git commit) and
 * ranges, plus duplicate-confirmation ("force") and large-range guard.
 */

export class TriggerError extends Error {
  constructor(message: string, public readonly statusCode: number = 400) {
    super(message);
  }
}

/** Warn (but allow) ranges larger than this — creates N review tasks. */
const LARGE_RANGE_THRESHOLD = 100;

interface RepoRow {
  id: number;
  type: 'svn' | 'git';
  url: string;
  username: string | null;
  credential_id: number | null;
  branch: string | null;
  source_version: number;
}

export interface TriggerSingleResponse {
  task: TaskRecord | null;
  duplicate: boolean;
}

export interface TriggerRangeResponse {
  tasks: TaskRecord[];
  duplicates: number;
  warning?: string;
}

export class TriggerService {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    private readonly queue: TaskQueue,
    private readonly dataDir: string
  ) {}

  retry(taskId: number): TaskRecord {
    const failed = this.queue.find(taskId);
    if (!failed) throw new TriggerError('任务不存在', 404);
    if (failed.status !== 'failed') throw new TriggerError('只有失败的任务可以重试', 409);

    const repo = this.getRepo(failed.repoId);
    if (repo.source_version !== (failed.sourceVersion ?? 0)) {
      throw new TriggerError('仓库来源已变更，请重新选择评审节点', 409);
    }
    return this.queue.enqueue(failed.repoId, failed.node, failed.trigger, failed.author, {
      sourceVersion: repo.source_version,
      monitorRuleId: failed.monitorRuleId,
      commit: { message: failed.commitMessage, date: failed.commitDate },
    });
  }

  /** Trigger a review of one node. Returns duplicate=true when it already ran. */
  async triggerSingle(
    repoId: number,
    node: string,
    opts: { force?: boolean } = {}
  ): Promise<TriggerSingleResponse> {
    const repo = this.getRepo(repoId);
    const auth = this.repoAuth(repo);

    if (repo.type === 'svn') {
      if (!/^\d+$/.test(node)) {
        throw new TriggerError(`SVN revision 必须是正整数: ${node}`);
      }
      const rev = Number(node);
      if (rev < 1) throw new TriggerError(`SVN revision 必须是正整数: ${node}`);
      // must exist on server (log of just that revision)
      let entry;
      try {
        // `-r N:N` yields exactly revision N; `-r N-1:N` would also return
        // N-1 (svn log ranges are inclusive), which is not what we want here.
        [entry] = await svnLog(repo.url, rev, rev, auth);
      } catch (err) {
        // E160006 = "No such revision": the repo is reachable, the node is not.
        if (/E160006|No such revision/i.test(errorMessage(err))) {
          throw new TriggerError(`revision ${rev} 不存在`, 404);
        }
        throw new TriggerError(`SVN 仓库不可达: ${errorMessage(err)}`, 502);
      }
      if (!entry || entry.revision !== rev) {
        throw new TriggerError(`revision ${rev} 不存在`, 404);
      }
      const task = this.enqueue(repo, String(rev), entry.author, opts.force, entry);
      return { task, duplicate: task === null };
    }

    // git: short or full sha must resolve and be unique
    const sha = await this.resolveGitCommit(repo, auth, node);
    const entry = await this.gitLogSingle(workCopyDir(this.dataDir, repo.id, repo.source_version), sha);
    const task = this.enqueue(repo, sha, entry.authorName, opts.force, entry);
    return { task, duplicate: task === null };
  }

  private async resolveGitCommit(
    repo: RepoRow,
    auth: { username?: string; password?: string },
    node: string
  ): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(node)) {
      throw new TriggerError(`非法 commit 哈希: ${node}`);
    }
    const wcDir = workCopyDir(this.dataDir, repo.id, repo.source_version);
    try {
      await ensureGitClone(wcDir, repo.url, auth);
    } catch (err) {
      throw new TriggerError(`Git 仓库不可达: ${errorMessage(err)}`, 502);
    }
    await gitFetchBranch(wcDir, repo.url, repo.branch ?? 'main', auth);
    const full = await gitResolveSha(wcDir, node);
    if (full) return full;
    // short sha: verify uniqueness (ambiguous prefix -> multiple matches)
    if (node.length < 40 && (await this.sharesPrefix(wcDir, node))) {
      throw new TriggerError(`commit ${node} 不唯一（存在多个匹配的前缀）`, 400);
    }
    throw new TriggerError(`commit ${node} 不存在`, 404);
  }

  /** True when more than one object shares this short-sha prefix. */
  private async sharesPrefix(wcDir: string, shortSha: string): Promise<boolean> {
    const { runGit } = await import('../vcs/git.js');
    try {
      const { stdout } = await runGit(['rev-parse', '--disambiguate', shortSha], {
        cwd: wcDir,
        timeoutMs: 15_000,
      });
      const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
      return lines.length > 1;
    } catch {
      return false; // no matches → "not found" path handles it
    }
  }

  /** Trigger reviews for every node in [from, to]. */
  async triggerRange(
    repoId: number,
    from: string,
    to: string,
    opts: { force?: boolean } = {}
  ): Promise<TriggerRangeResponse> {
    const repo = this.getRepo(repoId);
    const auth = this.repoAuth(repo);

    if (repo.type === 'svn') {
      return this.triggerSvnRange(repo, auth, from, to, opts.force);
    }
    return this.triggerGitRange(repo, auth, from, to, opts.force);
  }

  private async triggerSvnRange(
    repo: RepoRow,
    auth: { username?: string; password?: string },
    fromRaw: string,
    toRaw: string,
    force?: boolean
  ): Promise<TriggerRangeResponse> {
    if (!/^\d+$/.test(fromRaw) || !/^\d+$/.test(toRaw)) {
      throw new TriggerError('SVN 区间参数必须是正整数 revision');
    }
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (from < 1 || to < 1) throw new TriggerError('SVN revision 必须是正整数');
    if (from >= to) throw new TriggerError(`区间非法: from (${from}) 必须小于 to (${to})`);

    let entries;
    try {
      // svn log ranges are inclusive and error out past HEAD, so clamp `to`
      // to the current HEAD first (the range may legitimately overshoot when
      // the user types a round number).
      const info = await svnInfo(repo.url, auth);
      const end = Math.min(to, info.revision);
      if (end < from) {
        throw new TriggerError(`区间 [${from}, ${to}] 超出 HEAD (${info.revision})，没有可评审的 revision`, 404);
      }
      entries = await svnLog(repo.url, from, end, auth);
    } catch (err) {
      if (err instanceof TriggerError) throw err;
      throw new TriggerError(`SVN 仓库不可达: ${errorMessage(err)}`, 502);
    }
    if (entries.length === 0) {
      throw new TriggerError(`区间 [${from}, ${to}] 内没有 revision`, 404);
    }

    const warning =
      entries.length > LARGE_RANGE_THRESHOLD
        ? `区间包含 ${entries.length} 个 revision，将创建 ${entries.length} 个评审任务，执行可能耗时较长`
        : undefined;

    const tasks: TaskRecord[] = [];
    let duplicates = 0;
    for (const e of entries) {
      const t = this.enqueue(repo, String(e.revision), e.author, force, e);
      if (t) tasks.push(t);
      else duplicates++;
    }
    return { tasks, duplicates, warning };
  }

  private async triggerGitRange(
    repo: RepoRow,
    auth: { username?: string; password?: string },
    fromRaw: string,
    toRaw: string,
    force?: boolean
  ): Promise<TriggerRangeResponse> {
    const from = await this.resolveGitCommit(repo, auth, fromRaw);
    const to = await this.resolveGitCommit(repo, auth, toRaw);
    if (from === to) {
      throw new TriggerError('区间非法: 起始与结束 commit 相同');
    }

    // enumerate commits in [from, to] inclusive, oldest first; clone exists.
    const wcDir = workCopyDir(this.dataDir, repo.id, repo.source_version);
    let entries;
    try {
      const { runGit } = await import('../vcs/git.js');
      // from must be an ancestor of to (exit code 0)
      try {
        await runGit(['merge-base', '--is-ancestor', from, to], { cwd: wcDir, timeoutMs: 15_000 });
      } catch {
        // maybe the args are swapped; distinguish for a clearer error
        let swapped = false;
        try {
          await runGit(['merge-base', '--is-ancestor', to, from], { cwd: wcDir, timeoutMs: 15_000 });
          swapped = true;
        } catch {
          /* neither direction: unrelated branches */
        }
        throw new TriggerError(
          swapped
            ? '区间非法: 起始 commit 晚于结束 commit'
            : '区间非法: 起始与结束 commit 不在同一分支上',
          400
        );
      }
      // gitLog gives (from, to] oldest-first; prepend from itself
      const after = await gitLog(wcDir, from, to);
      const fromEntry = await this.gitLogSingle(wcDir, from);
      entries = [fromEntry, ...after];
    } catch (err) {
      if (err instanceof TriggerError) throw err;
      throw new TriggerError(`Git 仓库操作失败: ${errorMessage(err)}`, 502);
    }

    const warning =
      entries.length > LARGE_RANGE_THRESHOLD
        ? `区间包含 ${entries.length} 个 commit，将创建 ${entries.length} 个评审任务，执行可能耗时较长`
        : undefined;

    const tasks: TaskRecord[] = [];
    let duplicates = 0;
    for (const e of entries) {
      const t = this.enqueue(repo, e.sha, e.authorName, force, e);
      if (t) tasks.push(t);
      else duplicates++;
    }
    return { tasks, duplicates, warning };
  }

  /** One commit's log entry (same format as gitLog). */
  private async gitLogSingle(wcDir: string, sha: string) {
    const { runGit, parseGitLogOutput } = await import('../vcs/git.js');
    const { stdout } = await runGit(
      ['show', '-s', '--format=%x1e%H%n%an%n%ae%n%aI%n%s', sha],
      { cwd: wcDir, timeoutMs: 15_000 }
    );
    const [entry] = parseGitLogOutput(stdout + '\n');
    if (!entry) throw new TriggerError(`commit ${sha} 无法读取`, 502);
    return entry;
  }

  private enqueue(
    repo: RepoRow,
    node: string,
    author?: string,
    force?: boolean,
    commit?: { message?: string; date?: string }
  ): TaskRecord | null {
    if (repoSourceVersion(this.db, repo.id) !== repo.source_version) {
      throw new TriggerError('仓库来源已变更，请重新选择评审节点', 409);
    }
    const context = { sourceVersion: repo.source_version, commit };
    return force === true
      ? this.queue.enqueue(repo.id, node, 'manual', author, context)
      : this.queue.enqueueIfNew(repo.id, node, 'manual', author, context);
  }

  private getRepo(repoId: number): RepoRow {
    const row = this.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId) as RepoRow | undefined;
    if (!row) throw new TriggerError('仓库不存在', 404);
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
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // SvnError carries the useful text in stderr ("svn: E160006: No such …")
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return `${err.message}: ${stderr.trim()}`;
    return err.message;
  }
  return String(err);
}
