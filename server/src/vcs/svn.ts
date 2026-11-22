import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withWorkspaceLock } from './workspaceLock.js';
import { bindProcessAbort } from './processAbort.js';

export class SvnError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'SvnError';
  }
}

export interface SvnAuth {
  username?: string;
  password?: string;
}

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Extra env entries (merged over process.env). */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Callback used by task cancellation to kill the process. */
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
  /**
   * Allow svn to write credentials into its auth store. The platform's own
   * calls keep --no-auth-cache; only the one-time credential seeding for
   * `ocr` (which invokes svn itself with no auth flags) opts in.
   */
  cacheAuth?: boolean;
}

/**
 * Run an svn command and collect stdout/stderr. Cross-platform: spawn without
 * shell, args passed as an array (no shell metacharacter risk).
 */
export function runSvn(
  args: string[],
  auth: SvnAuth = {},
  opts: RunOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  opts.signal?.throwIfAborted();
  const fullArgs = [...args];
  if (auth.username) {
    fullArgs.push('--username', auth.username);
  }
  if (auth.password) {
    fullArgs.push('--password', auth.password);
  }
  // Never prompt for credentials. By default also skip caching them in
  // ~/.subversion/auth; only credential seeding for `ocr` opts in.
  fullArgs.push('--non-interactive');
  if (!opts.cacheAuth) fullArgs.push('--no-auth-cache');

  return new Promise((resolve, reject) => {
    const child = spawn('svn', fullArgs, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      detached: Boolean(opts.signal) && process.platform !== 'win32',
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
            reject(new SvnError(`svn ${args[0]} timed out after ${opts.timeoutMs}ms`, null, ''));
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
        reject(new SvnError(`failed to start svn: ${err.message}`, null, ''));
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
        reject(new SvnError(`svn ${args[0]} exited with code ${code}`, code, stderr.trim()));
      }
    });
  });
}

/** Minimal XML node used by the tiny parser below. */
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

export function decodeXmlEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
        if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
        return m;
    }
  });
}

/**
 * Tiny dependency-free XML parser sufficient for `svn info --xml` and
 * `svn log --xml` output (element names, attributes, text, one nesting level
 * of interest). Not a general XML parser: no namespaces, CDATA, or DTD.
 */
export function parseXml(xml: string): XmlNode {
  let i = 0;
  const skipProlog = () => {
    const prolog = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[\s\S]*?>/g;
    prolog.lastIndex = i;
    let m: RegExpExecArray | null;
    while ((m = prolog.exec(xml)) && m.index === i) {
      i = prolog.lastIndex;
    }
  };

  function parseElement(): XmlNode | null {
    skipProlog();
    // Skip whitespace between elements/prolog and the next tag.
    while (i < xml.length && /\s/.test(xml[i])) i++;
    if (xml[i] !== '<') return null;
    const tagMatch = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(i));
    if (!tagMatch) return null;
    i += tagMatch[0].length;
    const node: XmlNode = { tag: tagMatch[1], attrs: {}, text: '', children: [] };

    // attributes
    while (i < xml.length && xml[i] !== '>') {
      const attrMatch = /^\s*([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/.exec(xml.slice(i));
      if (!attrMatch) break;
      node.attrs[attrMatch[1]] = decodeXmlEntities(attrMatch[2]);
      i += attrMatch[0].length;
    }
    if (xml[i] === '>') i++;
    if (xml[i - 2] === '/') return node; // self-closing <tag/>

    // content
    while (i < xml.length) {
      if (xml[i] === '<') {
        if (xml[i + 1] === '/') {
          // closing tag
          const closeEnd = xml.indexOf('>', i);
          i = closeEnd + 1;
          return node;
        }
        const child = parseElement();
        if (child) node.children.push(child);
      } else {
        const next = xml.indexOf('<', i);
        const chunk = next === -1 ? xml.slice(i) : xml.slice(i, next);
        node.text += decodeXmlEntities(chunk);
        i += chunk.length;
      }
    }
    return node;
  }

  const root = parseElement();
  if (!root || !root.tag) {
    throw new SvnError('parseXml: no root element found', null, xml.slice(0, 100));
  }
  return root;
}

function findFirst(node: XmlNode, tag: string): XmlNode | undefined {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const found = findFirst(c, tag);
    if (found) return found;
  }
  return undefined;
}

function findAll(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (node.tag === tag) out.push(node);
  for (const c of node.children) out.push(...findAll(c, tag));
  return out;
}

export interface SvnInfo {
  url: string;
  repositoryRoot: string;
  revision: number;
}

/** Parse `svn info --xml` output. */
export function parseSvnInfoXml(xml: string): SvnInfo {
  const root = parseXml(xml);
  const entry = findFirst(root, 'entry');
  if (!entry) throw new SvnError('svn info XML: no <entry> element', null, xml.slice(0, 200));
  const url = findFirst(entry, 'url')?.text;
  const repoRoot = findFirst(entry, 'repository')?.children.find((c) => c.tag === 'root')?.text;
  const rev = entry.attrs.revision;
  if (!url || !repoRoot || !rev) {
    throw new SvnError('svn info XML: missing url/root/revision', null, xml.slice(0, 200));
  }
  return { url, repositoryRoot: repoRoot, revision: Number(rev) };
}

export interface SvnLogEntry {
  revision: number;
  author: string;
  /** ISO date string from svn log. */
  date: string;
  message: string;
  /** Paths changed in this revision, with action (A/D/M/R). */
  paths: { path: string; action: string }[];
}

/** Parse `svn log --xml` output into ordered entries. */
export function parseSvnLogXml(xml: string): SvnLogEntry[] {
  const root = parseXml(xml);
  const entries = findAll(root, 'logentry');
  return entries.map((e) => {
    const author = findFirst(e, 'author')?.text ?? '';
    const date = findFirst(e, 'date')?.text ?? '';
    const msg = findFirst(e, 'msg')?.text ?? '';
    const paths = findAll(e, 'path').map((p) => ({
      path: p.text,
      action: p.attrs.action ?? 'M',
    }));
    return {
      revision: Number(e.attrs.revision),
      author,
      date,
      message: msg,
      paths,
    };
  });
}

/** Verify connectivity to an SVN URL; throws SvnError with detail on failure. */
export async function svnInfo(url: string, auth: SvnAuth = {}, opts: RunOptions = {}): Promise<SvnInfo> {
  const { stdout } = await runSvn(['info', '--xml', url], auth, { timeoutMs: 30_000, ...opts });
  return parseSvnInfoXml(stdout);
}

/** Initialize a managed cache, replacing a stale checkout left by older versions. */
export async function ensureSvnWorkspace(
  path: string,
  url: string,
  auth: SvnAuth,
  opts: RunOptions = {}
): Promise<void> {
  const normalizeUrl = (value: string) => new URL(value).href.replace(/\/+$/, '');
  await withWorkspaceLock(path, opts.signal, async () => {
    if (existsSync(join(path, '.svn'))) {
      const current = await svnInfo(path, auth, opts);
      if (normalizeUrl(current.url) === normalizeUrl(url)) return;
      const expected = await svnInfo(url, auth, opts);
      if (normalizeUrl(current.url) === normalizeUrl(expected.url)) return;
      rmSync(path, { recursive: true, force: true });
    }
    mkdirSync(path, { recursive: true });
    await runSvn(['checkout', url, path], auth, {
      timeoutMs: 30 * 60_000,
      ...opts,
      cacheAuth: true,
    });
  });
}

/** Update a working copy to a revision (default HEAD), populating any
 *  previously sparse (`--depth empty`) copy to a full tree. */
export async function svnUpdate(
  workingCopyPath: string,
  revision: number | 'HEAD',
  auth: SvnAuth = {},
  opts: RunOptions = {}
): Promise<void> {
  await runSvn(
    ['update', '-r', String(revision), '--set-depth', 'infinity', workingCopyPath],
    auth,
    {
      timeoutMs: 30 * 60_000,
      ...opts,
    }
  );
}

/** Fetch log entries in (from, to] — both numbers, or `HEAD` for to. */
export async function svnLog(
  target: string,
  from: number,
  to: number | 'HEAD',
  auth: SvnAuth = {},
  opts: RunOptions & { limit?: number } = {}
): Promise<SvnLogEntry[]> {
  const range = `${from}:${to}`;
  const args = ['log', '--xml', '-v', '-r', range];
  // `--limit N` counts *entries returned*, not revisions spanned: on a
  // subdirectory URL it yields the path's own N most recent commits, so the
  // picker shows real history even when the repo-wide HEAD is far ahead.
  if (opts.limit && opts.limit > 0) args.push('--limit', String(opts.limit));
  args.push(target);
  const { stdout } = await runSvn(args, auth, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    onSpawn: opts.onSpawn,
  });
  const entries = parseSvnLogXml(stdout);
  // svn log returns newest-first; normalize to oldest-first.
  return entries.sort((a, b) => a.revision - b.revision);
}

/**
 * One page of log entries NEWEST-first (svn's native order for a descending
 * range), for the node picker's cursor pagination. `start` is the first
 * revision to look at: 'HEAD' for the first page, or <oldest-shown>-1 for
 * the next older page (the descending range is inclusive, so -1 avoids
 * repeats). `--limit` counts *entries returned*, so on a subdirectory URL a
 * page holds the path's own N most recent commits regardless of repo HEAD.
 */
export async function svnLogPage(
  target: string,
  start: number | 'HEAD',
  auth: SvnAuth = {},
  opts: RunOptions & { limit?: number } = {}
): Promise<SvnLogEntry[]> {
  const args = ['log', '--xml', '-v', '-r', `${start}:1`];
  if (opts.limit && opts.limit > 0) args.push('--limit', String(opts.limit));
  args.push(target);
  const { stdout } = await runSvn(args, auth, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    onSpawn: opts.onSpawn,
  });
  return parseSvnLogXml(stdout); // newest-first; callers paginate on it
}
