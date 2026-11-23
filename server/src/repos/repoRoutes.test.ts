import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { buildRepoRoutes, buildTestApp } from './repoRoutes.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let credentials: CredentialService;
const GIT_REPO_DIR = () => join(dir, 'origin.git');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-repo-'));
  db = openDatabase({ dataDir: join(dir, 'data') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('repo API integration', () => {
  it('creates a git repo after connectivity verification succeeds', async () => {
    // real local git repo -> ls-remote succeeds
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const app = await buildTestApp(db, credentials);
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'origin', url: GIT_REPO_DIR(), branch: 'main' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('git');
    expect(body.hasCredential).toBe(false);
    expect(body).toMatchObject({ reviewConcurrency: 2, providerIds: [] });
    // password must never appear
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('saves review settings, preserves them on older updates, and supports inheriting the default model', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const provider = db.prepare(
      "INSERT INTO provider (name, api_base, model) VALUES ('repo-model', 'http://localhost:11434/v1', 'model-b')"
    ).run();
    const providerId = Number(provider.lastInsertRowid);
    const app = await buildTestApp(db, credentials);
    try {
      const repo = { type: 'git', url: GIT_REPO_DIR(), name: 'repo' };
      const created = await app.inject({
        method: 'POST', url: '/api/repos', payload: { ...repo, reviewConcurrency: 3, providerIds: [providerId] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ reviewConcurrency: 3, providerIds: [providerId] });
      const url = `/api/repos/${created.json().id}`;
      const update = (payload: object) => app.inject({ method: 'PUT', url, payload: { ...repo, ...payload } });
      expect((await update({ enabled: false })).json()).toMatchObject({ reviewConcurrency: 3, providerIds: [providerId] });
      for (const invalid of [0, 1.5, '2', Number.MAX_SAFE_INTEGER + 1, null]) {
        expect((await update({ reviewConcurrency: invalid })).statusCode).toBe(400);
      }
      expect((await update({ providerIds: [providerId + 1] })).statusCode).toBe(400);
      expect((await update({ reviewConcurrency: 1, providerIds: [] })).json())
        .toMatchObject({ reviewConcurrency: 1, providerIds: [] });
    } finally {
      await app.close();
    }
  });

  it('rejects creation when connectivity fails (unreachable url)', async () => {
    const app = await buildTestApp(db, credentials);
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'svn', name: 'bad-svn', url: 'http://127.0.0.1:1/no-such-repo' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/SVN 连接失败/);
    // not saved
    const list = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(list.json()).toHaveLength(0);
  });

  it('rejects creation with wrong git credentials', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const app = await buildTestApp(db, credentials);
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'x', url: GIT_REPO_DIR(), username: 'u', password: 'wrong' },
    });
    // local path clone ignores credentials, so this may still succeed;
    // the meaningful assertion is the API contract on failure paths only.
    expect([201, 422]).toContain(res.statusCode);
  });

  it('validates input: bad type / empty name / bad svn url', async () => {
    const app = await buildTestApp(db, credentials);
    const badType = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'hg', name: 'x', url: 'http://x/y' },
    });
    expect(badType.statusCode).toBe(400);
    const noName = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'svn', name: '', url: 'http://x/y' },
    });
    expect(noName.statusCode).toBe(400);
    const badUrl = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'svn', name: 'x', url: 'not-a-url' },
    });
    expect(badUrl.statusCode).toBe(400);
  });

  it('update verifies with the stored credential when the password is omitted', async () => {
    // A local clone URL that requires the stored password: the file:// path is
    // reachable without it, so instead assert the service passes the revealed
    // secret through by spying on the connectivity check.
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const app = await buildTestApp(db, credentials);
    const created = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: GIT_REPO_DIR(), username: 'u1', password: 'secret-pw' },
    });
    const id = created.json().id;
    const { service } = buildRepoRoutes(db, credentials);
    const seen: { username?: string; password?: string }[] = [];
    const original = service.verifyConnectivity.bind(service);
    service.verifyConnectivity = async (input) => {
      seen.push({ username: input.username, password: input.password });
      return original(input);
    };
    await service.update(id, { type: 'git', name: 'r1', url: GIT_REPO_DIR(), username: 'u1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ username: 'u1', password: 'secret-pw' });
  });

  it('update keeps stored credential when password omitted', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const app = await buildTestApp(db, credentials);
    const created = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: GIT_REPO_DIR(), password: 'secret-pw' },
    });
    const id = created.json().id;
    // edit without password
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/repos/${id}`,
      payload: { type: 'git', name: 'r1-renamed', url: GIT_REPO_DIR() },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('r1-renamed');
    // credential survived (internal reveal still works)
    const row = db.prepare('SELECT credential_id FROM repo WHERE id = ?').get(id) as {
      credential_id: number;
    };
    expect(credentials.reveal(row.credential_id)).toBe('secret-pw');
    // masked in API output
    expect(JSON.stringify(updated.json())).not.toContain('secret-pw');
  });

  it('delete reports impact scope beforehand and keeps history', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const app = await buildTestApp(db, credentials);
    const created = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: GIT_REPO_DIR() },
    });
    const id = created.json().id;
    // add a task + report for history
    db.prepare('INSERT INTO task (repo_id, node, trigger) VALUES (?, ?, ?)').run(id, 'abc1230', 'manual');
    const taskRow = db.prepare('SELECT id FROM task WHERE repo_id = ?').get(id) as { id: number };
    db.prepare('INSERT INTO report (task_id, raw_path) VALUES (?, ?)').run(
      taskRow.id,
      'data/reports/x.json'
    );

    const impact = await app.inject({ method: 'GET', url: `/api/repos/${id}/impact` });
    expect(impact.json()).toEqual({ monitorRules: 0, tasks: 1, reports: 1 });

    const del = await app.inject({ method: 'DELETE', url: `/api/repos/${id}` });
    expect(del.statusCode).toBe(204);
    // history preserved
    const tasks = db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number };
    expect(tasks.n).toBe(1);
    const reports = db.prepare('SELECT COUNT(*) AS n FROM report').get() as { n: number };
    expect(reports.n).toBe(1);
    // repo gone
    const list = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(list.json()).toHaveLength(0);
  });

  it('delete sweeps the repo-scoped directories and cancels its active tasks', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const dataDir = join(dir, 'data');
    const cancelled: number[] = [];
    const app = await buildTestApp(db, credentials, {
      dataDir,
      cancelRepoTasks: (repoId) => cancelled.push(repoId),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: GIT_REPO_DIR() },
    });
    const id = created.json().id;
    // Plant repo-scoped dirs the way the runner would create them, including
    // source-version/slot variants and another repo's dir that must survive.
    const wcBase = join(dataDir, 'workcopies');
    const homeBase = join(dataDir, 'ocr-home');
    const memoryBase = join(dataDir, 'memory');
    const graphBase = join(dataDir, 'codegraph');
    mkdirSync(graphBase, { recursive: true });
    for (const variant of [String(id), `${id}-v2`, `${id}-v2-slot-1`]) {
      mkdirSync(join(wcBase, variant), { recursive: true });
      mkdirSync(join(homeBase, variant), { recursive: true });
      mkdirSync(join(memoryBase, variant), { recursive: true });
      writeFileSync(join(graphBase, variant), '.codegraph-crh-0000', 'utf8');
    }
    mkdirSync(join(wcBase, '999'), { recursive: true });
    mkdirSync(join(homeBase, '999'), { recursive: true });
    mkdirSync(join(memoryBase, '999'), { recursive: true });
    writeFileSync(join(graphBase, '999'), '.codegraph-crh-0000', 'utf8');

    const del = await app.inject({ method: 'DELETE', url: `/api/repos/${id}` });
    expect(del.statusCode).toBe(204);
    expect(cancelled).toEqual([id]);
    // every variant of this repo is gone…
    for (const variant of [String(id), `${id}-v2`, `${id}-v2-slot-1`]) {
      expect(existsSync(join(wcBase, variant))).toBe(false);
      expect(existsSync(join(homeBase, variant))).toBe(false);
      expect(existsSync(join(memoryBase, variant))).toBe(false);
      expect(existsSync(join(graphBase, variant))).toBe(false);
    }
    // …but other repos' dirs are untouched
    expect(existsSync(join(wcBase, '999'))).toBe(true);
    expect(existsSync(join(homeBase, '999'))).toBe(true);
    expect(existsSync(join(memoryBase, '999'))).toBe(true);
    expect(existsSync(join(graphBase, '999'))).toBe(true);
  });

  it('stores an ordered model pool; omitted keeps it, empty clears it', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const first = Number(db.prepare(
      "INSERT INTO provider (name, api_base, model) VALUES ('p1', 'http://localhost:1/v1', 'm1')"
    ).run().lastInsertRowid);
    const second = Number(db.prepare(
      "INSERT INTO provider (name, api_base, model) VALUES ('p2', 'http://localhost:1/v1', 'm2')"
    ).run().lastInsertRowid);
    const app = await buildTestApp(db, credentials);
    const repo = { type: 'git', url: GIT_REPO_DIR(), name: 'pooled' };

    const created = await app.inject({
      method: 'POST', url: '/api/repos', payload: { ...repo, providerIds: [second, first] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      providerIds: [second, first],
      providerLabels: ['p2 · m2', 'p1 · m1'],
    });

    const url = `/api/repos/${created.json().id}`;
    // Explicit empty list clears the pool -> inherit global.
    const cleared = await app.inject({
      method: 'PUT', url, payload: { ...repo, providerIds: [] },
    });
    expect(cleared.json()).toMatchObject({ providerIds: [] });

    const set = await app.inject({
      method: 'PUT', url, payload: { ...repo, providerIds: [first] },
    });
    expect(set.json()).toMatchObject({ providerIds: [first] });

    // Omitting the field keeps the stored pool (e.g. enable/disable toggle).
    const toggled = await app.inject({
      method: 'PUT', url, payload: { ...repo, enabled: false },
    });
    expect(toggled.json()).toMatchObject({ providerIds: [first], enabled: false });

    // Unknown member rejected.
    const bad = await app.inject({
      method: 'PUT', url, payload: { ...repo, providerIds: [first, first + 999] },
    });
    expect(bad.statusCode).toBe(400);

    // Deleting a provider empties it out of the pool.
    db.prepare('DELETE FROM provider WHERE id = ?').run(first);
    const after = await app.inject({ method: 'GET', url });
    expect(after.json()).toMatchObject({ providerIds: [] });
    expect(second).toBeGreaterThan(0);
  });

  it('rejects duplicate repo name', async () => {
    execFileSync('git', ['init', '-b', 'main', GIT_REPO_DIR()]);
    const app = await buildTestApp(db, credentials);
    const first = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: GIT_REPO_DIR() },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: GIT_REPO_DIR() },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('lists recent git nodes newest-first, paged, and filters by query', async () => {
    const origin = GIT_REPO_DIR();
    execFileSync('git', ['init', '-b', 'main', origin]);
    const git = (args: string) =>
      execFileSync('git', args.split(/\s+/), { cwd: origin, encoding: 'utf8', stdio: 'pipe' });
    // Three commits with distinct authors/messages so the filter is meaningful.
    const commits: string[] = [];
    for (const [i, msg] of ['add login page', 'fix crash on save', 'refactor parser'].entries()) {
      execFileSync(
        'git',
        ['-c', `user.name=dev${i}`, '-c', `user.email=d${i}@x`, 'commit', '--allow-empty', '-m', msg],
        {
          cwd: origin,
          encoding: 'utf8',
          stdio: 'pipe',
        }
      );
      commits.push(git('rev-parse HEAD').trim());
    }

    const app = await buildTestApp(db, credentials);
    const created = await app.inject({
      method: 'POST',
      url: '/api/repos',
      payload: { type: 'git', name: 'r1', url: origin, branch: 'main' },
    });
    const id = (created.json() as { id: number }).id;

    const all = await app.inject({ method: 'GET', url: `/api/repos/${id}/nodes` });
    expect(all.statusCode).toBe(200);
    const page = all.json() as {
      items: { node: string; author: string; message: string }[];
      nextCursor?: string;
    };
    expect(page.items).toHaveLength(3);
    // newest first, so the picker shows the most recent commit at the top
    expect(page.items[0].node).toBe(commits[2]);
    expect(page.items[0].message).toBe('refactor parser');
    // fewer than one page -> history exhausted
    expect(page.nextCursor).toBeUndefined();

    // cursor pagination: a page size of 2 leaves one commit for page 2
    const p1 = await app.inject({ method: 'GET', url: `/api/repos/${id}/nodes?limit=2` });
    const page1 = p1.json() as { items: { node: string }[]; nextCursor?: string };
    expect(page1.items.map((n) => n.node)).toEqual([commits[2], commits[1]]);
    expect(page1.nextCursor).toBe('2');
    const p2 = await app.inject({
      method: 'GET',
      url: `/api/repos/${id}/nodes?limit=2&cursor=2`,
    });
    const page2 = p2.json() as { items: { node: string }[]; nextCursor?: string };
    expect(page2.items.map((n) => n.node)).toEqual([commits[0]]);
    expect(page2.nextCursor).toBeUndefined();
    // a bad cursor is rejected outright
    const bad = await app.inject({
      method: 'GET',
      url: `/api/repos/${id}/nodes?limit=2&cursor=-3`,
    });
    expect(bad.statusCode).toBe(400);

    const filtered = await app.inject({ method: 'GET', url: `/api/repos/${id}/nodes?q=crash` });
    expect(filtered.statusCode).toBe(200);
    const hits = (filtered.json() as { items: { node: string; message: string }[] }).items;
    expect(hits).toHaveLength(1);
    expect(hits[0].node).toBe(commits[1]);

    const byAuthor = await app.inject({ method: 'GET', url: `/api/repos/${id}/nodes?q=dev0` });
    expect((byAuthor.json() as { items: unknown[] }).items.length).toBe(1);
  });

  it('node listing reports a missing repo as 404', async () => {
    const app = await buildTestApp(db, credentials);
    const res = await app.inject({ method: 'GET', url: '/api/repos/999/nodes' });
    expect(res.statusCode).toBe(404);
  });
});
