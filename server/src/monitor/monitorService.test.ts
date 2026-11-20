import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { TaskQueue, type TaskRecord } from '../tasks/taskQueue.js';
import { MonitorService } from './monitorService.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let dataDir: string;
let queue: TaskQueue;
let monitor: MonitorService;

const okExecutor = async () => ({ exitCode: 0 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-monitor-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  dataDir = join(dir, 'data');
  queue = new TaskQueue(db, okExecutor, 2);
  const credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  monitor = new MonitorService(db, credentials, queue, { dataDir });
});

afterEach(async () => {
  monitor?.stop();
  queue?.stop();
  db?.close();
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

// ---------------------------------------------------------------- SVN helpers

function svnUrl(p: string): string {
  const win = p.replace(/\\/g, '/');
  return `file:///${win.replace(/^\/+/, '')}`;
}

/** Create a local SVN repo with `commits` revisions; returns url + revisions. */
function makeSvnRepo(
  commits: { author: string; files: Record<string, string> }[]
): { url: string; revisions: number[] } {
  const repoDir = join(dir, 'svnrepo');
  execFileSync('svnadmin', ['create', repoDir]);
  const url = svnUrl(repoDir);
  const wc = join(dir, 'svnwc');
  execFileSync('svn', ['checkout', url, wc]);
  const revisions: number[] = [];
  for (const c of commits) {
    for (const [name, content] of Object.entries(c.files)) {
      const full = join(wc, name);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
      execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    }
    const out = execFileSync('svn', ['commit', '-m', 'msg', '--username', c.author], { cwd: wc, encoding: 'utf8' }).toString();
    const m = /Committed revision (\d+)/.exec(out);
    revisions.push(Number(m![1]));
  }
  return { url, revisions };
}

function addRepo(type: 'svn' | 'git', url: string, branch?: string): number {
  const info = db
    .prepare('INSERT INTO repo (type, name, url, branch) VALUES (?, ?, ?, ?)')
    .run(type, `repo-${Date.now()}-${Math.random()}`, url, branch ?? null);
  return Number(info.lastInsertRowid);
}

function addRule(
  repoId: number,
  opts: {
    authors?: string[];
    paths?: string[];
    backtrack?: number;
    interval?: number;
    enabled?: boolean;
  } = {}
): number {
  const info = db
    .prepare(
      `INSERT INTO monitor_rule
         (repo_id, interval_seconds, author_whitelist, path_prefixes, backtrack_nodes, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      repoId,
      opts.interval ?? 60,
      JSON.stringify(opts.authors ?? []),
      JSON.stringify(opts.paths ?? []),
      opts.backtrack ?? 0,
      opts.enabled === false ? 0 : 1
    );
  return Number(info.lastInsertRowid);
}

function tasks(): TaskRecord[] {
  return queue.list({}).items;
}

function logs(ruleId: number) {
  return db
    .prepare('SELECT * FROM monitor_log WHERE rule_id = ? ORDER BY id')
    .all(ruleId) as {
    node: string;
    action: string;
    reason: string | null;
    author: string | null;
  }[];
}

// ---------------------------------------------------------------- SVN tests

describe('SVN monitor (4.1/4.3/4.4)', () => {
  it('first enable starts at HEAD without backtracking history', async () => {
    const { url, revisions } = makeSvnRepo([
      { author: 'alice', files: { 'a.txt': '1' } },
      { author: 'bob', files: { 'b.txt': '2' } },
      { author: 'carol', files: { 'c.txt': '3' } },
    ]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId);

    await monitor.enableRule(ruleId);
    // position initialized to HEAD-1 => no historical tasks
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(0);

    // new commit after enabling is picked up
    const wc = join(dir, 'svnwc');
    writeFileSync(join(wc, 'd.txt'), '4');
    execFileSync('svn', ['add', join(wc, 'd.txt')], { cwd: wc });
    const out = execFileSync('svn', ['commit', '-m', 'msg', '--username', 'dave'], { cwd: wc, encoding: 'utf8' }).toString();
    const rev = Number(/Committed revision (\d+)/.exec(out)![1]);

    await monitor.pollRule(ruleId);
    await queue.idle();
    const t = tasks();
    expect(t).toHaveLength(1);
    expect(t[0].node).toBe(String(rev));
    expect(t[0].trigger).toBe('auto');
    expect(t[0].author).toBe('dave');
    expect(revisions).toHaveLength(3);
  });

  it('backtrack N reviews the last N nodes on first enable', async () => {
    const { url } = makeSvnRepo([
      { author: 'alice', files: { 'a.txt': '1' } },
      { author: 'bob', files: { 'b.txt': '2' } },
      { author: 'carol', files: { 'c.txt': '3' } },
    ]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId, { backtrack: 2 });

    await monitor.enableRule(ruleId);
    await monitor.pollRule(ruleId);
    await queue.idle();
    const nodes = tasks().map((t) => t.node).sort();
    expect(nodes).toEqual(['2', '3']);
  });

  it('detects multiple new revisions in one poll, oldest first', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    for (let i = 2; i <= 4; i++) {
      writeFileSync(join(wc, `f${i}.txt`), String(i));
      execFileSync('svn', ['add', join(wc, `f${i}.txt`)], { cwd: wc });
      execFileSync('svn', ['commit', '-m', `c${i}`, '--username', `u${i}`], { cwd: wc });
    }
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks().map((t) => t.node).sort()).toEqual(['2', '3', '4']);
  });

  it('author whitelist: hit triggers, miss is logged as skipped', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId, { authors: ['zhangsan'] });
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    writeFileSync(join(wc, 'b.txt'), 'b');
    execFileSync('svn', ['add', join(wc, 'b.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'wangwu'], { cwd: wc });
    writeFileSync(join(wc, 'c.txt'), 'c');
    execFileSync('svn', ['add', join(wc, 'c.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'zhangsan'], { cwd: wc });

    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].author).toBe('zhangsan');
    const log = logs(ruleId);
    expect(log.find((l) => l.author === 'wangwu')?.action).toBe('skipped');
    expect(log.find((l) => l.author === 'wangwu')?.reason).toContain('白名单');
  });

  it('path filter: prefix hit triggers, non-matching path skipped', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'trunk/src/core/a.cpp': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId, { paths: ['trunk/src/core/'] });
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    mkdirSync(join(wc, 'docs'), { recursive: true });
    writeFileSync(join(wc, 'docs/readme.md'), 'doc');
    execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'docs change', '--username', 'alice'], { cwd: wc });
    mkdirSync(join(wc, 'trunk/src/core'), { recursive: true });
    writeFileSync(join(wc, 'trunk/src/core/b.cpp'), 'code');
    execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'code change', '--username', 'alice'], { cwd: wc });

    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);
    const log = logs(ruleId);
    expect(log.find((l) => l.reason?.includes('监控路径'))?.action).toBe('skipped');
  });

  it('combined author+path filters use AND semantics', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'trunk/src/core/a.cpp': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId, { authors: ['zhangsan'], paths: ['trunk/src/core/'] });
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    // author matches, path doesn't
    mkdirSync(join(wc, 'docs'), { recursive: true });
    writeFileSync(join(wc, 'docs/x.md'), 'x');
    execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'zhangsan'], { cwd: wc });
    // path matches, author doesn't
    mkdirSync(join(wc, 'trunk/src/core'), { recursive: true });
    writeFileSync(join(wc, 'trunk/src/core/y.cpp'), 'y');
    execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'wangwu'], { cwd: wc });
    // both match
    mkdirSync(join(wc, 'trunk/src/core'), { recursive: true });
    writeFileSync(join(wc, 'trunk/src/core/z.cpp'), 'z');
    execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'zhangsan'], { cwd: wc });

    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].author).toBe('zhangsan');
    expect(logs(ruleId).filter((l) => l.action === 'skipped')).toHaveLength(2);
  });

  it('does not re-create tasks when the same node is polled twice (dedup)', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    writeFileSync(join(wc, 'b.txt'), 'b');
    execFileSync('svn', ['add', join(wc, 'b.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'alice'], { cwd: wc });

    await monitor.pollRule(ruleId);
    await queue.idle();
    // simulate a lost position (e.g. crash before persist) by rewinding it
    db.prepare('UPDATE monitor_state SET last_node = ? WHERE rule_id = ?').run('1', ruleId);
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);
  });

  it('records poll failure and keeps the position for retry', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);
    const before = db
      .prepare('SELECT last_node FROM monitor_state WHERE rule_id = ?')
      .get(ruleId) as { last_node: string };

    // make the repo unreachable
    rmSync(join(dir, 'svnrepo'), { recursive: true, force: true });
    await monitor.pollRule(ruleId);
    const state = db
      .prepare('SELECT last_node, last_poll_error FROM monitor_state WHERE rule_id = ?')
      .get(ruleId) as { last_node: string; last_poll_error: string | null };
    expect(state.last_poll_error).toBeTruthy();
    expect(state.last_node).toBe(before.last_node); // position unchanged
  });

  it('disable stops polling; restart resumes from persisted position', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    writeFileSync(join(wc, 'b.txt'), 'b');
    execFileSync('svn', ['add', join(wc, 'b.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'alice'], { cwd: wc });
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);

    // disable: pollRule is a no-op
    monitor.disableRule(ruleId);
    writeFileSync(join(wc, 'c.txt'), 'c');
    execFileSync('svn', ['add', join(wc, 'c.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'alice'], { cwd: wc });
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);

    // simulate restart: new MonitorService instance, rule re-enabled
    monitor.stop();
    const credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
    monitor = new MonitorService(db, credentials, queue, { dataDir });
    db.prepare('UPDATE monitor_rule SET enabled = 1 WHERE id = ?').run(ruleId);
    monitor.start();
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(2); // the missed node is picked up
  });

  it('deleting a repo disarms its timer and a stale tick cannot crash the poll', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);
    expect(monitor.status(ruleId)).toHaveLength(1);

    // Delete the repo the way the console does: the rule cascades away, then
    // syncRepo runs. A timer left armed here would fire against a dead rule.
    db.prepare('DELETE FROM repo WHERE id = ?').run(repoId);
    monitor.syncRepo(repoId);
    expect(monitor.status().some((s) => s.ruleId === ruleId)).toBe(false);

    // Even if a tick is already queued, polling a vanished rule must be a
    // quiet no-op — not a throw that escapes the timer callback.
    await expect(monitor.pollRule(ruleId)).resolves.toBeUndefined();
    // and it must not attempt to write monitor_state for the dead rule
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM monitor_state WHERE rule_id = ?').get(ruleId) as {
        n: number;
      }).n
    ).toBe(0);
  });

  it('status() reports position, last poll and recent trigger/skip log', async () => {
    const { url } = makeSvnRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('svn', url);
    const ruleId = addRule(repoId, { authors: ['alice'] });
    await monitor.enableRule(ruleId);

    const wc = join(dir, 'svnwc');
    writeFileSync(join(wc, 'b.txt'), 'b');
    execFileSync('svn', ['add', join(wc, 'b.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'alice'], { cwd: wc });
    writeFileSync(join(wc, 'c.txt'), 'c');
    execFileSync('svn', ['add', join(wc, 'c.txt')], { cwd: wc });
    execFileSync('svn', ['commit', '-m', 'm', '--username', 'bob'], { cwd: wc });

    await monitor.pollRule(ruleId);
    await queue.idle();
    const [st] = monitor.status(ruleId);
    expect(st.enabled).toBe(true);
    expect(st.lastPollAt).toBeTruthy();
    expect(st.lastNode).toBe('3');
    expect(st.headNode).toBe('3'); // latest remote revision at the last poll
    expect(st.recentLog.map((l) => l.action).sort()).toEqual(['skipped', 'triggered']);
  });
});

// ---------------------------------------------------------------- Git tests

function makeGitRepo(
  commits: { author: string; files: Record<string, string> }[]
): { url: string; shas: string[] } {
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-b', 'main', origin]);
  const shas: string[] = [];
  for (const c of commits) {
    for (const [name, content] of Object.entries(c.files)) {
      const full = join(origin, name);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync('git', ['add', '-A'], { cwd: origin });
    execFileSync('git', ['-c', `user.name=${c.author}`, '-c', `user.email=${c.author}@t`, 'commit', '-m', 'msg'], {
      cwd: origin,
    });
    shas.push(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' }).toString().trim());
  }
  return { url: origin, shas };
}

function gitCommit(origin: string, author: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    const full = join(origin, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: origin });
  execFileSync('git', ['-c', `user.name=${author}`, '-c', `user.email=${author}@t`, 'commit', '-m', 'msg'], { cwd: origin });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' }).toString().trim();
}

describe('Git monitor (4.2/4.3/4.4)', () => {
  it('first enable starts at current HEAD; new commits are detected in order', async () => {
    const { url } = makeGitRepo([
      { author: 'alice', files: { 'a.txt': '1' } },
      { author: 'bob', files: { 'b.txt': '2' } },
    ]);
    const repoId = addRepo('git', url, 'main');
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(0);

    const s1 = gitCommit(url, 'carol', { 'c.txt': '3' });
    const s2 = gitCommit(url, 'dave', { 'd.txt': '4' });
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect([...tasks().map((t) => t.node)].sort()).toEqual([s1, s2].sort());
    expect([...tasks().map((t) => t.author)].sort()).toEqual(['carol', 'dave']);
  });

  it('git author whitelist and path filters apply', async () => {
    const { url } = makeGitRepo([{ author: 'alice', files: { 'src/core/a.cpp': '1' } }]);
    const repoId = addRepo('git', url, 'main');
    const ruleId = addRule(repoId, { authors: ['carol'], paths: ['src/core/'] });
    await monitor.enableRule(ruleId);

    gitCommit(url, 'carol', { 'docs/readme.md': 'doc' }); // author ok, path no
    gitCommit(url, 'dave', { 'src/core/b.cpp': 'code' }); // path ok, author no
    const good = gitCommit(url, 'carol', { 'src/core/c.cpp': 'code' }); // both ok
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].node).toBe(good);
    expect(logs(ruleId).filter((l) => l.action === 'skipped')).toHaveLength(2);
  });

  it('git backtrack N reviews the last N commits', async () => {
    const { url, shas } = makeGitRepo([
      { author: 'alice', files: { 'a.txt': '1' } },
      { author: 'bob', files: { 'b.txt': '2' } },
      { author: 'carol', files: { 'c.txt': '3' } },
    ]);
    const repoId = addRepo('git', url, 'main');
    const ruleId = addRule(repoId, { backtrack: 2 });
    await monitor.enableRule(ruleId);
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks().map((t) => t.node).sort()).toEqual([shas[1], shas[2]].sort());
  });

  it('git poll failure keeps position and recovers on next poll', async () => {
    const { url } = makeGitRepo([{ author: 'alice', files: { 'a.txt': '1' } }]);
    const repoId = addRepo('git', url, 'main');
    const ruleId = addRule(repoId);
    await monitor.enableRule(ruleId);
    const before = (db.prepare('SELECT last_node FROM monitor_state WHERE rule_id = ?').get(ruleId) as {
      last_node: string;
    }).last_node;

    const moved = `${url}-moved`;
    execFileSync('mv', [url, moved]);
    await monitor.pollRule(ruleId);
    const st = db
      .prepare('SELECT last_node, last_poll_error FROM monitor_state WHERE rule_id = ?')
      .get(ruleId) as { last_node: string; last_poll_error: string | null };
    expect(st.last_poll_error).toBeTruthy();
    expect(st.last_node).toBe(before);

    execFileSync('mv', [moved, url]);
    const sha = gitCommit(url, 'bob', { 'b.txt': '2' });
    await monitor.pollRule(ruleId);
    await queue.idle();
    expect(tasks().map((t) => t.node)).toEqual([sha]);
  });
});
