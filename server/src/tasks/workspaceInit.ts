import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { workCopyDir } from './ocrRunner.js';
import { ensureGitClone } from '../vcs/git.js';
import { ensureSvnWorkspace } from '../vcs/svn.js';
import { ocrHomeDir } from '../engines/ocrEngine.js';
import { prepareOcrHomeSvnConfig } from '../providers/ocrProviderConfig.js';
import type { LogService } from '../logs/logService.js';

/**
 * Workspace prewarm: downloads the repository (SVN checkout / git clone)
 * right after the repo is saved instead of lazily during the first review.
 *
 * Shares the workspace initialization lock with the review and monitor paths.
 * Tracks progress in the repo row so the console can show status and retry.
 */

export type RepoInitStatus = 'pending' | 'preparing' | 'ready' | 'failed';

interface InitRow {
  id: number;
  type: 'svn' | 'git';
  url: string;
  username: string | null;
  credential_id: number | null;
  source_version: number;
}

export class WorkspaceInitService {
  private readonly inFlight = new Set<string>();

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
    const row = this.db.prepare(
      'SELECT id, type, url, username, credential_id, source_version FROM repo WHERE id = ?'
    ).get(repoId) as InitRow | undefined;
    if (!row) return false;
    const wcDir = workCopyDir(this.dataDir, repoId, row.source_version);
    if (this.inFlight.has(wcDir)) return false;

    this.inFlight.add(wcDir);
    this.mark(row, 'preparing', null);
    void this.run(row, wcDir)
      .catch((err) => this.logs?.error('task', `仓库 #${repoId} 工作副本状态写入失败: ${String(err)}`))
      .finally(() => this.inFlight.delete(wcDir));
    return true;
  }

  private async run(row: InitRow, wcDir: string): Promise<void> {
    try {
      const auth = {
        username: row.username ?? undefined,
        password: row.credential_id ? this.credentials.reveal(row.credential_id) ?? undefined : undefined,
      };
      if (row.type === 'svn') {
        // Seed credentials under the same HOME that ocr will use.
        const home = ocrHomeDir(this.dataDir, row.id, row.source_version);
        prepareOcrHomeSvnConfig(home);
        await ensureSvnWorkspace(wcDir, row.url, auth, { env: { HOME: home, USERPROFILE: home } });
      } else {
        await ensureGitClone(wcDir, row.url, auth);
      }
      if (this.mark(row, 'ready', null)) this.logs?.info('task', `仓库 #${row.id} 工作副本初始化完成`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.mark(row, 'failed', reason)) this.logs?.error('task', `仓库 #${row.id} 工作副本初始化失败: ${reason}`);
    }
  }

  private mark(row: InitRow, status: RepoInitStatus, error: string | null): boolean {
    return this.db
      .prepare(
        `UPDATE repo
         SET init_status = ?, init_error = ?,
             init_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND source_version = ?`
      )
      .run(status, error, row.id, row.source_version).changes > 0;
  }
}
