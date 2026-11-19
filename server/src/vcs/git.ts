import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitAuth {
  username?: string;
  /** Password or personal access token. */
  password?: string;
}

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
}

/**
 * Run a git command in a repo directory (or globally when no cwd).
 * Credentials are passed per-invocation via stdin-askpass or URL-embedded
 * userinfo — never written to any config or credential store.
 */
export function runGit(
  args: string[],
  opts: GitRunOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: Record<string, string> = {
    ...(process.env as unknown as Record<string, string>),
    ...opts.env,
  };
  // Never prompt or cache anything: credentials are injected per-call into
  // the remote URL by injectCredentialsInUrl() (see callers), and git must
  // not consult global/system config stores for them.
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_ASKPASS'] = '';
  env['GIT_CONFIG_NOSYSTEM'] = '1';

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      env,
    });
    opts.onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
          if (!settled) {
            settled = true;
            reject(new GitError(`git ${args[0]} timed out after ${opts.timeoutMs}ms`, null, ''));
          }
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new GitError(`failed to start git: ${err.message}`, null, ''));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new GitError(`git ${args[0]} exited with code ${code}`, code, stderr.trim()));
      }
    });
  });
}

/**
 * Embed credentials in a remote URL: https://host/path -> https://user:pass@host/path.
 * Callers keep the credentialed URL in memory only — never persisted, never
 * logged, never written to git config.
 */
export function injectCredentialsInUrl(url: string, auth: GitAuth): string {
  if (!auth.username && !auth.password) return url;
  // Only http(s) supports userinfo credentials.
  const m = /^(https?)(:\/\/)(.+)$/.exec(url);
  if (!m) return url;
  const userinfo = `${encodeURIComponent(auth.username ?? '')}:${encodeURIComponent(auth.password ?? '')}`;
  // Strip any existing userinfo before injecting.
  const rest = m[3].replace(/^[^@/]+@/, '');
  return `${m[1]}${m[2]}${userinfo}@${rest}`;
}

/** Check a remote is reachable and readable. Returns the default HEAD sha. */
export async function gitLsRemote(
  url: string,
  auth: GitAuth = {},
  opts: GitRunOptions = {}
): Promise<{ refs: { ref: string; sha: string }[] }> {
  const credentialed = injectCredentialsInUrl(url, auth);
  const { stdout } = await runGit(['ls-remote', credentialed], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  const refs: { ref: string; sha: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40})\s+(?:[a-z]+\s+)?(\S+)$/.exec(line);
    if (m) refs.push({ sha: m[1], ref: m[2] });
  }
  return { refs };
}

/** Clone (first time) with credentials, no config writes. All branches fetched as needed later. */
export async function gitClone(
  url: string,
  dest: string,
  auth: GitAuth = {},
  opts: GitRunOptions = {}
): Promise<void> {
  const credentialed = injectCredentialsInUrl(url, auth);
  await runGit(
    ['clone', '--filter=blob:none', '--no-checkout', credentialed, dest],
    { ...opts, timeoutMs: opts.timeoutMs ?? 30 * 60_000 }
  );
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  /** ISO date. */
  date: string;
  message: string;
  files: string[];
}

/**
 * List commits in [from, to] as oldest-first, with changed file names.
 * Uses the ASCII record separator (\x1e) via git's %xNN escape and
 * --name-only for robust parsing (names with spaces, quotes, or
 * non-ASCII survive; real NUL bytes are rejected by Windows spawn).
 */
export async function gitLog(
  cwd: string,
  from: string,
  to: string,
  opts: GitRunOptions = {}
): Promise<GitLogEntry[]> {
  const { stdout } = await runGit(
    [
      'log',
      '--reverse',
      '--format=%x1e%H%n%an%n%ae%n%aI%n%s',
      '--name-only',
      '-z',
      `${from}..${to}`,
    ],
    { ...opts, cwd, timeoutMs: opts.timeoutMs ?? 60_000 }
  );
  return parseGitLogOutput(stdout);
}

/**
 * The most recent `count` commits reachable from `ref`, oldest-first.
 * Unlike `gitLog(cwd, `${ref}~N`, ref)` this works on short histories
 * (fewer than N commits) instead of failing on an unresolvable `~N`.
 */
export async function gitLogRecent(
  cwd: string,
  ref: string,
  count: number,
  opts: GitRunOptions = {}
): Promise<GitLogEntry[]> {
  const { stdout } = await runGit(
    [
      'log',
      '--reverse',
      '--format=%x1e%H%n%an%n%ae%n%aI%n%s',
      '--name-only',
      '-z',
      `-n`,
      String(Math.max(1, count)),
      ref,
    ],
    { ...opts, cwd, timeoutMs: opts.timeoutMs ?? 60_000 }
  );
  return parseGitLogOutput(stdout);
}

/**
 * One page of commits NEWEST-first, `skip` commits past `ref`'s tip, for the
 * node picker's incremental "load older" paging (`skip` = how many are
 * already shown). An empty result means the history is exhausted.
 */
export async function gitLogPage(
  cwd: string,
  ref: string,
  skip: number,
  count: number,
  opts: GitRunOptions = {}
): Promise<GitLogEntry[]> {
  const { stdout } = await runGit(
    [
      'log',
      '--format=%x1e%H%n%an%n%ae%n%aI%n%s',
      '--name-only',
      '-z',
      '--skip',
      String(Math.max(0, skip)),
      '-n',
      String(Math.max(1, count)),
      ref,
    ],
    { ...opts, cwd, timeoutMs: opts.timeoutMs ?? 60_000 }
  );
  return parseGitLogOutput(stdout); // git log order: newest-first
}

export function parseGitLogOutput(stdout: string): GitLogEntry[] {
  const sep = '\u001e';
  const entries: GitLogEntry[] = [];
  // Split into record blocks by the record separator.
  const blocks = stdout.split(sep).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    // -z makes --name-only entries NUL-separated; within a block the header
    // lines are newline-separated and file names may still be joined by \0.
    const normalized = block.replace(/\0/g, '\n');
    const lines = normalized.split(/\r?\n/);
    const [sha, authorName, authorEmail, date, subject, ...fileLines] = lines;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    entries.push({
      sha,
      shortSha: sha.slice(0, 7),
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      message: subject ?? '',
      files: (fileLines ?? []).filter((f) => f.trim().length > 0),
    });
  }
  return entries;
}

/** Fetch and check out a commit in a working clone (with credentials). */
export async function gitPrepareCommit(
  repoDir: string,
  remoteUrl: string,
  sha: string,
  auth: GitAuth = {},
  opts: GitRunOptions = {}
): Promise<void> {
  // Fetch from the credentialed URL (config 'origin' may lack credentials).
  const credentialed = injectCredentialsInUrl(remoteUrl, auth);
  await runGit(['fetch', '--no-tags', credentialed, sha], {
    cwd: repoDir,
    ...opts,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
  await runGit(['checkout', '--force', sha], {
    cwd: repoDir,
    ...opts,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
}

/** Resolve a short or full sha to a unique full sha; null if unknown/ambiguous. */
export async function gitResolveSha(
  cwd: string,
  rev: string,
  opts: GitRunOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${rev}^{commit}`], {
      cwd,
      ...opts,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Fetch remote branch updates into FETCH_HEAD (no config writes). */
export async function gitFetchBranch(
  repoDir: string,
  remoteUrl: string,
  branch: string,
  auth: GitAuth = {},
  opts: GitRunOptions = {}
): Promise<void> {
  const credentialed = injectCredentialsInUrl(remoteUrl, auth);
  // Fetch into the remote-tracking ref so callers can resolve origin/<branch>.
  // (A bare `git fetch <url> <branch>` only writes FETCH_HEAD.)
  await runGit(['fetch', '--no-tags', credentialed, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: repoDir,
    ...opts,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
}
