import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withWorkspaceLock } from './workspaceLock.js';
import { bindProcessAbort } from './processAbort.js';

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
  signal?: AbortSignal;
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
}

/**
 * Run a git command in a repo directory (or globally when no cwd).
 * Remote invocations use an ephemeral credential helper (see gitRemote).
 */
export function runGit(
  args: string[],
  opts: GitRunOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  opts.signal?.throwIfAborted();
  const env: Record<string, string> = {
    ...(process.env as unknown as Record<string, string>),
    ...opts.env,
  };
  // A service process must never prompt for credentials.
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_ASKPASS'] = '';
  env['GIT_CONFIG_NOSYSTEM'] = '1';

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      detached: Boolean(opts.signal) && process.platform !== 'win32',
      env,
    });
    const unbind = bindProcessAbort(child, opts.signal);
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
      unbind();
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new GitError(`failed to start git: ${err.message}`, null, ''));
      }
    });
    child.on('close', (code) => {
      unbind();
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal?.aborted) {
        reject(opts.signal.reason);
      } else if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new GitError(`git ${args[0]} exited with code ${code}`, code, stderr.trim()));
      }
    });
  });
}

const TEMPORARY_HELPER = `!f() {
  if [ "$1" = get ]; then
    printf 'username=%s\\npassword=%s\\n' "$CRP_GIT_USERNAME" "$CRP_GIT_PASSWORD"
  fi
}; f`;

/** Keep secrets in the process environment and scope the helper to the remote host. */
export function gitRemote(
  url: string,
  auth: GitAuth = {},
  inheritedEnv: Record<string, string> = {}
): { url: string; env: Record<string, string> } {
  if (!/^https?:\/\//i.test(url)) return { url, env: inheritedEnv };
  const remote = new URL(url);
  const explicitAuth = Boolean(auth.username || auth.password);
  const username = explicitAuth ? auth.username ?? '' : decodeURIComponent(remote.username);
  const password = explicitAuth ? auth.password ?? '' : decodeURIComponent(remote.password);
  if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(password)) {
    throw new GitError('Git 凭据含换行或空字符', null, '');
  }
  const hadUserinfo = Boolean(remote.username || remote.password);
  remote.username = '';
  remote.password = '';
  const env = { ...inheritedEnv, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' };
  // Git propagates -c settings to subprocesses in this format. It also
  // works on Git versions that predate GIT_CONFIG_COUNT.
  const gitQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const config = [
    inheritedEnv.GIT_CONFIG_PARAMETERS ?? process.env.GIT_CONFIG_PARAMETERS ?? '',
    gitQuote('credential.helper='),
  ];
  if (username || password) {
    config.push(gitQuote(`credential.${remote.origin}.helper=${TEMPORARY_HELPER}`));
    Object.assign(env, { CRP_GIT_USERNAME: username, CRP_GIT_PASSWORD: password });
  }
  return { url: hadUserinfo ? remote.href : url, env: { ...env, GIT_CONFIG_PARAMETERS: config.join(' ').trim() } };
}

export async function scrubGitCloneCredentials(repoDir: string): Promise<void> {
  let output: string;
  try {
    ({ stdout: output } = await runGit(['config', '--local', '--get-all', 'remote.origin.url'], { cwd: repoDir }));
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return; // no origin
    throw err;
  }
  const urls = output.trimEnd().split(/\r?\n/);
  const clean = urls.map((url) => {
    if (!/^https?:\/\//i.test(url)) return url;
    const remote = new URL(url);
    if (!remote.username && !remote.password) return url;
    remote.username = '';
    remote.password = '';
    return remote.href;
  });
  if (clean.some((url, index) => url !== urls[index])) {
    await runGit(['config', '--local', '--replace-all', 'remote.origin.url', clean[0]], { cwd: repoDir });
    for (const url of clean.slice(1)) {
      await runGit(['config', '--local', '--add', 'remote.origin.url', url], { cwd: repoDir });
    }
  }
}

/** Clean managed clones created before credentials moved out of remote URLs. */
export async function scrubCachedGitCredentials(
  dataDir: string,
  onError: (name: string) => void
): Promise<void> {
  for (const category of ['workcopies', 'node-cache']) {
    const root = join(dataDir, category);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+(?:-v\d+)?$/.test(entry.name)) continue;
      const dir = join(root, entry.name);
      if (!existsSync(join(dir, '.git', 'config'))) continue;
      try {
        await scrubGitCloneCredentials(dir);
      } catch {
        onError(`${category}/${entry.name}`);
      }
    }
  }
}

/** Check a remote is reachable and readable. Returns the default HEAD sha. */
export async function gitLsRemote(
  url: string,
  auth: GitAuth = {},
  opts: GitRunOptions = {}
): Promise<{ refs: { ref: string; sha: string }[] }> {
  const remote = gitRemote(url, auth, opts.env);
  const { stdout } = await runGit(['ls-remote', '--', remote.url], {
    ...opts,
    env: remote.env,
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
  const remote = gitRemote(url, auth, opts.env);
  await runGit(
    ['clone', '--filter=blob:none', '--no-checkout', '--', remote.url, dest],
    { ...opts, env: remote.env, timeoutMs: opts.timeoutMs ?? 30 * 60_000 }
  );
}

export async function ensureGitClone(
  dest: string,
  url: string,
  auth: GitAuth,
  opts: GitRunOptions = {}
): Promise<void> {
  await withWorkspaceLock(dest, opts.signal, async () => {
    if (existsSync(join(dest, '.git'))) return;
    mkdirSync(dirname(dest), { recursive: true });
    await gitClone(url, dest, auth, opts);
  });
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

async function readGitLog(cwd: string, args: string[], opts: GitRunOptions): Promise<GitLogEntry[]> {
  const runOptions = { ...opts, cwd, timeoutMs: opts.timeoutMs ?? 60_000 };
  const { stdout } = await runGit(
    ['log', '--topo-order', '--format=%x1e%H%n%an%n%ae%n%aI%n%s%n%P', '--no-renames', '--name-only', '-z', ...args],
    runOptions
  );
  const entries = parseGitLogRecords(stdout, true);
  for (const { entry, parents } of entries) {
    if (parents.length < 2) continue;
    // Git omits merge diffs from a plain log. Include the effective change
    // introduced onto the destination branch, including conflict resolutions.
    const diff = await runGit(['diff', '--no-renames', '--name-only', '-z', parents[0], entry.sha], runOptions);
    entry.files = diff.stdout.split('\0').filter(Boolean);
  }
  return entries.map(({ entry }) => entry);
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
  return readGitLog(cwd, ['--reverse', from ? `${from}..${to}` : to], opts);
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
  return readGitLog(cwd, ['--reverse', '-n', String(Math.max(1, count)), ref], opts);
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
  return readGitLog(cwd, ['--skip', String(Math.max(0, skip)), '-n', String(Math.max(1, count)), ref], opts);
}

export function parseGitLogOutput(stdout: string): GitLogEntry[] {
  return parseGitLogRecords(stdout, false).map(({ entry }) => entry);
}

function parseGitLogRecords(stdout: string, hasParents: boolean): { entry: GitLogEntry; parents: string[] }[] {
  const sep = '\u001e';
  const entries: { entry: GitLogEntry; parents: string[] }[] = [];
  // Split into record blocks by the record separator.
  const blocks = stdout.split(sep).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    // -z makes --name-only entries NUL-separated; within a block the header
    // lines are newline-separated and file names may still be joined by \0.
    const normalized = block.replace(/\0/g, '\n');
    const lines = normalized.split(/\r?\n/);
    const [sha, authorName, authorEmail, date, subject, ...fileLines] = lines;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const parents = hasParents ? (fileLines.shift() ?? '').split(' ').filter(Boolean) : [];
    entries.push({
      entry: {
        sha,
        shortSha: sha.slice(0, 7),
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        date: date ?? '',
        message: subject ?? '',
        files: fileLines.filter((f) => f.trim().length > 0),
      },
      parents,
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
  const remote = gitRemote(remoteUrl, auth, opts.env);
  await runGit(['fetch', '--no-tags', '--', remote.url, sha], {
    cwd: repoDir,
    ...opts,
    env: remote.env,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
  await runGit(['checkout', '--force', sha], {
    cwd: repoDir,
    ...opts,
    env: remote.env,
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
    opts.signal?.throwIfAborted();
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
  const remote = gitRemote(remoteUrl, auth, opts.env);
  // Fetch into the remote-tracking ref so callers can resolve origin/<branch>.
  // (A bare `git fetch <url> <branch>` only writes FETCH_HEAD.)
  await runGit(['fetch', '--no-tags', '--', remote.url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: repoDir,
    ...opts,
    env: remote.env,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
}
