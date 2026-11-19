import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CredentialService } from '../crypto/credentialService.js';
import { svnInfo, svnLogPage, SvnError } from '../vcs/svn.js';
import {
  gitClone,
  gitFetchBranch,
  gitLogPage,
  gitLsRemote,
  gitResolveSha,
  GitError,
} from '../vcs/git.js';

export type RepoType = 'svn' | 'git';

/** One page of selectable nodes for the trigger page's picker. */
export interface NodePage {
  items: RepoNode[];
  /** Opaque cursor for the next (older) page; undefined when exhausted. */
  nextCursor?: string;
}

/** One selectable node in the trigger page's picker. */
export interface RepoNode {
  /** SVN revision number or full git SHA. */
  node: string;
  author: string;
  /** ISO date. */
  date: string;
  message: string;
  /** Changed paths (may be empty when the log omits them). */
  files: string[];
}

export interface RepoInput {
  type: RepoType;
  name: string;
  url: string;
  username?: string;
  password?: string; // write-only; never returned
  branch?: string; // git only
  enabled?: boolean;
}

export type RepoInitStatus = 'pending' | 'preparing' | 'ready' | 'failed';

export interface RepoRecord {
  id: number;
  type: RepoType;
  name: string;
  url: string;
  username?: string;
  branch?: string;
  enabled: boolean;
  hasCredential: boolean;
  /** Workspace prewarm state: pending/preparing = download in flight. */
  initStatus: RepoInitStatus;
  initError?: string;
  createdAt: string;
  updatedAt: string;
}

export class RepoServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
  }
}

/**
 * Repo configuration CRUD. On create/update, connectivity is verified first
 * (svn info / git ls-remote); a failing check aborts the save with the
 * underlying error detail. Deleting a repo keeps its history (tasks,
 * reports) — only the config row (and cascade-linked monitor rule) goes.
 */
export class RepoService {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    /** Where the node picker's git clone cache lives; defaults to the OS temp dir. */
    private readonly dataDir?: string
  ) {}

  /** Verify the repo is reachable with the given credentials. */
  async verifyConnectivity(input: RepoInput): Promise<void> {
    if (input.type === 'svn') {
      try {
        await svnInfo(input.url, { username: input.username, password: input.password });
      } catch (err) {
        const detail = err instanceof SvnError ? err.stderr || err.message : String(err);
        throw new RepoServiceError(`SVN 连接失败: ${detail}`, 422);
      }
    } else {
      try {
        await gitLsRemote(input.url, {
          username: input.username,
          password: input.password,
        });
      } catch (err) {
        const detail = err instanceof GitError ? err.stderr || err.message : String(err);
        throw new RepoServiceError(`Git 连接失败: ${detail}`, 422);
      }
    }
  }

  async create(input: RepoInput): Promise<RepoRecord> {
    this.validateInput(input);
    const dup = this.db.prepare('SELECT id FROM repo WHERE name = ?').get(input.name);
    if (dup) throw new RepoServiceError(`仓库 "${input.name}" 已存在`, 409);
    await this.verifyConnectivity(input);

    const credentialId = input.password
      ? this.credentials.store(`repo:${input.name}`, input.type, input.password)
      : null;

    const info = this.db
      .prepare(
        `INSERT INTO repo (type, name, url, username, credential_id, branch, enabled, init_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        input.type,
        input.name,
        input.url,
        input.username ?? null,
        credentialId,
        input.type === 'git' ? input.branch ?? 'main' : null,
        input.enabled === false ? 0 : 1
      );
    return this.get(Number(info.lastInsertRowid));
  }

  async update(id: number, input: RepoInput): Promise<RepoRecord> {
    const existing = this.db
      .prepare('SELECT * FROM repo WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!existing) throw new RepoServiceError('仓库不存在', 404);
    this.validateInput(input);

    // The console never echoes the stored password, so an edit (or a plain
    // enable/disable toggle) sends no password. Verify with the credential
    // that is already stored — otherwise every edit of a credentialed repo
    // would fail the connectivity check and the change would never save.
    const storedCredentialId = (existing.credential_id as number | null) ?? null;
    const effectivePassword =
      input.password ?? (storedCredentialId ? this.credentials.reveal(storedCredentialId) ?? undefined : undefined);
    await this.verifyConnectivity({
      ...input,
      username: input.username ?? ((existing.username as string | null) ?? undefined),
      password: effectivePassword,
    });

    let credentialId = (existing.credential_id as number | null) ?? null;
    if (input.password) {
      if (credentialId) {
        this.credentials.update(credentialId, input.password);
      } else {
        credentialId = this.credentials.store(`repo:${input.name}`, input.type, input.password);
      }
    }

    this.db
      .prepare(
        `UPDATE repo
         SET type = ?, name = ?, url = ?, username = ?, credential_id = ?,
             branch = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(
        input.type,
        input.name,
        input.url,
        input.username ?? null,
        credentialId,
        input.type === 'git' ? input.branch ?? 'main' : null,
        input.enabled === false ? 0 : 1,
        id
      );
    return this.get(id);
  }

  /**
   * Delete a repo. Caller (API layer) is responsible for prompting about
   * impact scope; this reports the counts so the UI can show them.
   */
  describeImpact(id: number): { monitorRules: number; tasks: number; reports: number } {
    const count = (sql: string, ...args: (string | number)[]) =>
      (this.db.prepare(sql).get(...args) as { n: number }).n;
    return {
      monitorRules: count('SELECT COUNT(*) AS n FROM monitor_rule WHERE repo_id = ?', id),
      tasks: count('SELECT COUNT(*) AS n FROM task WHERE repo_id = ?', id),
      reports: count(
        'SELECT COUNT(*) AS n FROM report WHERE task_id IN (SELECT id FROM task WHERE repo_id = ?)',
        id
      ),
    };
  }

  delete(id: number): void {
    const existing = this.db.prepare('SELECT id, credential_id FROM repo WHERE id = ?').get(id) as
      | { id: number; credential_id: number | null }
      | undefined;
    if (!existing) throw new RepoServiceError('仓库不存在', 404);
    // monitor_rule/state cascade via FK; task/report history is kept
    // (task rows reference repo but we keep them for history display).
    this.db.prepare('DELETE FROM repo WHERE id = ?').run(id);
    if (existing.credential_id) this.credentials.delete(existing.credential_id);
    // Drop the picker's cached clone; leaving it behind would leak disk space
    // and could be reused by a later repo that happens to get the same id.
    // A concurrent picker load may be cloning/fetching inside the cache dir
    // and hold a lock on it (EPERM/EBUSY on Windows) — deleting the repo must
    // still succeed, and an orphaned cache is harmless (the next clone
    // recreates the directory from scratch).
    try {
      rmSync(this.nodesCacheDir(id), { recursive: true, force: true });
    } catch {
      // ignore: cache removal is best-effort
    }
  }

  get(id: number): RepoRecord {
    const row = this.db
      .prepare('SELECT * FROM repo WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new RepoServiceError('仓库不存在', 404);
    return this.toRecord(row);
  }

  list(): RepoRecord[] {
    const rows = this.db.prepare('SELECT * FROM repo ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.toRecord(r));
  }

  /** Internal: repo url + decrypted password, for VCS operations. */
  auth(id: number): { type: RepoType; url: string; username?: string; password?: string; branch?: string } {
    const row = this.db
      .prepare('SELECT * FROM repo WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new RepoServiceError('仓库不存在', 404);
    return {
      type: row.type as RepoType,
      url: row.url as string,
      username: (row.username as string | null) ?? undefined,
      password: row.credential_id
        ? (this.credentials.reveal(row.credential_id as number) ?? undefined)
        : undefined,
      branch: (row.branch as string | null) ?? undefined,
    };
  }

  /**
   * List nodes (SVN revisions / git commits) for the trigger page's picker,
   * NEWEST-first, one page at a time. The frontend loads page 1 on open and
   * asks for the next page when the user scrolls to the bottom, passing back
   * the opaque `cursor`. `query` filters by node, author, message or changed
   * path; a filtered page continues from `cursor` too, so "load more" walks
   * deeper history even while searching.
   *
   * Cursor formats (opaque to the caller): svn `<revision>`, git `<skip>`.
   */
  async listNodes(
    id: number,
    opts: { limit?: number; query?: string; cursor?: string } = {}
  ): Promise<NodePage> {
    const repo = this.auth(id);
    // `Number('?limit=abc')` is NaN, which `?? 100` would not catch and
    // `Math.min/max` would propagate into every slice/range below.
    const requested = Number.isFinite(opts.limit) ? (opts.limit as number) : 100;
    const limit = Math.min(Math.max(requested, 1), 500);
    const query = (opts.query ?? '').trim().toLowerCase();
    const matches = (node: RepoNode) =>
      !query ||
      node.node.toLowerCase().includes(query) ||
      node.author.toLowerCase().includes(query) ||
      node.message.toLowerCase().includes(query) ||
      node.files.some((f) => f.toLowerCase().includes(query));

    if (repo.type === 'svn') {
      // Cursor = the revision AFTER the last one returned (oldest shown - 1);
      // the descending range `-r <cursor>:1` is inclusive, so -1 avoids
      // repeating the boundary entry.
      let cursorRev: number | 'HEAD' = 'HEAD';
      if (opts.cursor !== undefined) {
        const n = Number(opts.cursor);
        if (!Number.isInteger(n) || n < 0) {
          throw new RepoServiceError('非法分页游标', 400);
        }
        cursorRev = n;
      }
      let entries;
      try {
        entries = await svnLogPage(
          repo.url,
          cursorRev,
          { username: repo.username, password: repo.password },
          { limit }
        );
      } catch (err) {
        const detail = err instanceof SvnError ? err.stderr || err.message : String(err);
        throw new RepoServiceError(`SVN 日志读取失败: ${detail}`, 422);
      }
      const items = entries
        .map((e) => ({
          node: String(e.revision),
          author: e.author,
          date: e.date,
          message: e.message,
          files: e.paths.map((p) => p.path),
        }))
        .filter(matches);
      // Fewer than `limit` entries came back: history is exhausted. (svn log
      // on a subdirectory can also end early; same signal.)
      const hasMore = entries.length === limit;
      const next = hasMore ? String(Number(items[items.length - 1]?.node ?? 1) - 1) : undefined;
      return { items, nextCursor: Number(next) > 0 ? next : undefined };
    }

    // git: reuse a cached clone (the picker is queried on every keystroke, so
    // cloning per request would be unusable on a large repo).
    const branch = repo.branch ?? 'main';
    const auth = { username: repo.username, password: repo.password };
    const dir = this.nodesCacheDir(id);
    try {
      if (!existsSync(join(dir, '.git'))) {
        mkdirSync(dirname(dir), { recursive: true });
        rmSync(dir, { recursive: true, force: true });
        await gitClone(repo.url, dir, auth);
      }
      await gitFetchBranch(dir, repo.url, branch, auth);
      const head = await gitResolveSha(dir, `origin/${branch}`);
      if (!head) throw new RepoServiceError(`无法解析 origin/${branch}`, 422);
      // Cursor = how many commits are already shown (git --skip is an offset
      // from the tip; cheap because the clone is local).
      const skip = opts.cursor !== undefined ? Number(opts.cursor) : 0;
      if (!Number.isInteger(skip) || skip < 0) {
        throw new RepoServiceError('非法分页游标', 400);
      }
      const entries = await gitLogPage(dir, head, skip, limit);
      const items = entries
        .map((e) => ({
          node: e.sha,
          author: e.authorName,
          date: e.date,
          message: e.message,
          files: e.files,
        }))
        .filter(matches);
      const hasMore = entries.length === limit;
      return { items, nextCursor: hasMore ? String(skip + limit) : undefined };
    } catch (err) {
      if (err instanceof RepoServiceError) throw err;
      const detail = err instanceof GitError ? err.stderr || err.message : String(err);
      throw new RepoServiceError(`Git 日志读取失败: ${detail}`, 422);
    }
  }

  /**
   * Where the picker's git clone lives. Kept apart from the runner's working
   * copy so a background review checking out a commit cannot disturb it.
   */
  private nodesCacheDir(repoId: number): string {
    return this.dataDir
      ? join(this.dataDir, 'node-cache', String(repoId))
      : join(tmpdir(), `crp-nodes-${repoId}`);
  }

  private toRecord(row: Record<string, unknown>): RepoRecord {
    return {
      id: row.id as number,
      type: row.type as RepoType,
      name: row.name as string,
      url: row.url as string,
      username: (row.username as string | null) ?? undefined,
      branch: (row.branch as string | null) ?? undefined,
      enabled: Boolean(row.enabled),
      hasCredential: Boolean(row.credential_id),
      initStatus: (row.init_status as RepoInitStatus) ?? 'ready',
      initError: (row.init_error as string | null) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private validateInput(input: RepoInput): void {
    if (!['svn', 'git'].includes(input.type)) {
      throw new RepoServiceError('仓库类型必须为 svn 或 git');
    }
    if (!input.name?.trim()) throw new RepoServiceError('仓库名不能为空');
    if (!input.url?.trim()) throw new RepoServiceError('仓库地址不能为空');
    if (input.type === 'svn' && !/^(https?|svn(\+ssh)?|file):\/\//.test(input.url.trim())) {
      throw new RepoServiceError('SVN 地址格式不合法');
    }
    if (input.type === 'git' && input.branch && !/^[\w./-]+$/.test(input.branch)) {
      throw new RepoServiceError('Git 分支名含非法字符');
    }
  }
}
