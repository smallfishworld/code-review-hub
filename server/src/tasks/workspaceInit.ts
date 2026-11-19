import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { workCopyDir } from './ocrRunner.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LogService } from '../logs/logService.js';

/**
 * Workspace prewarm: downloads the repository (SVN checkout / git clone)
 * right after the repo is saved instead of lazily during the first review.
 *
 * The runner (`OcrRunner.prepareSvnWorkCopy` / `prepareGitClone`) still
 * handles its own bootstrap — the real prepare is idempotent, it skips the
 * checkout/clone when the workspace already exists. Prewarm runs the same
 * operations standalone and tracks progress in the repo row's init columns
 * so the console can show "初始化中" and a failure reason with a retry.
 */

export type RepoInitStatus = 'pending' | 'preparing' | 'ready' | 'failed';

interface InitRow {
  id: number;
  type: 'svn' | 'git';
  url: string;
  username: string | null;
  credential_id: number | null;
  branch: string | null;
  init_status: RepoInitStatus;
}

/** In-process serialization: one init per repo, never two in parallel. */
const inFlight = new Set<number>();

export class WorkspaceInitService {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    private readonly dataDir: string,
    private readonly logs?: LogService
  ) {}

  /** Public status for the console. */
  statusOf(repoId: number): { status: RepoInitStatus; error: string | null; updatedAt: string | null } {
    const row = this.db
      .prepare('SELECT init_status, init_error, init_updated_at FROM repo WHERE id = ?')
      .get(repoId) as
      | { init_status: RepoInitStatus; init_error: string | null; init_updated_at: string | null }
      | undefined;
    if (!row) throw new Error(`repo ${repoId} not found`);
    return { status: row.init_status, error: row.init_error, updatedAt: row.init_updated_at };
  }

  /**
   * Kick a background init for the repo. Returns false when one is already
   * running (or the repo is gone). Errors are recorded on the repo row, not
   * thrown — callers fire-and-forget.
   */
  start(repoId: number): boolean {
    if (inFlight.has(repoId)) return false;
    const row = this.db
      .prepare(
        'SELECT id, type, url, username, credential_id, branch, init_status FROM repo WHERE id = ?'
      )
      .get(repoId) as InitRow | undefined;
    if (!row) return false;
    // Workspace already downloaded (a previous review or init did it):
    // nothing to do but confirm ready.
    if (existsSync(join(workCopyDir(this.dataDir, repoId), row.type === 'svn' ? '.svn' : '.git'))) {
      this.mark(repoId, 'ready', null);
      return true;
    }

    inFlight.add(repoId);
    this.mark(repoId, 'preparing', null);
    void this.run(repoId, row).finally(() => inFlight.delete(repoId));
    return true;
  }

  private async run(repoId: number, row: InitRow): Promise<void> {
    const auth = {
      url: row.url,
      username: row.username ?? undefined,
      password: row.credential_id
        ? (this.credentials.reveal(row.credential_id) ?? undefined)
        : undefined,
      branch: row.branch ?? undefined,
    };
    const wcDir = workCopyDir(this.dataDir, repoId);
    try {
      if (row.type === 'svn') {
        const { runSvn, svnInfo } = await import('../vcs/svn.js');
        const svnAuth = { username: auth.username, password: auth.password };
        mkdirSync(wcDir, { recursive: true });
        // Full checkout (see OcrRunner.prepareSvnWorkCopy for rationale).
        // CRITICAL: cacheAuth=true on the server-touching call — svn only
        // writes credentials into its auth store during an AUTHENTICATED
        // server exchange, and `svn info <wc>` is purely local (it never
        // contacts the server, so it can never seed). On Windows svn builds
        // its config/auth dir from $HOME ($HOME\AppData\Roaming\Subversion)
        // and ocr's own svn calls run under that redirected HOME — seeding
        // anywhere else leaves the redirected store empty and the review
        // hangs on an invisible auth prompt forever.
        const { prepareOcrHomeSvnConfig } = await import('../providers/ocrProviderConfig.js');
        const ocrHome = join(this.dataDir, 'ocr-home');
        // servers file: cert-trust so an intranet https checkout cannot
        // prompt either.
        prepareOcrHomeSvnConfig(ocrHome);
        const homeEnv = { HOME: ocrHome, USERPROFILE: ocrHome };
        await runSvn(['checkout', auth.url, wcDir], svnAuth, {
          timeoutMs: 30 * 60_000,
          cacheAuth: true,
          env: homeEnv,
        });
        await svnInfo(wcDir, svnAuth);
      } else {
        const { gitClone } = await import('../vcs/git.js');
        mkdirSync(join(wcDir, '..'), { recursive: true });
        await gitClone(auth.url, wcDir, {
          username: auth.username,
          password: auth.password,
        });
      }
      this.mark(repoId, 'ready', null);
      this.logs?.info('task', `仓库 #${repoId} 工作副本初始化完成`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.mark(repoId, 'failed', reason);
      this.logs?.error('task', `仓库 #${repoId} 工作副本初始化失败: ${reason}`);
    }
  }

  private mark(repoId: number, status: RepoInitStatus, error: string | null): void {
    this.db
      .prepare(
        `UPDATE repo
         SET init_status = ?, init_error = ?,
             init_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(status, error, repoId);
  }
}
