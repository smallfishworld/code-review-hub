import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGitLogOutput,
  injectCredentialsInUrl,
  gitLsRemote,
  gitLog,
  gitResolveSha,
  runGit,
  gitClone,
  gitFetchBranch,
  gitPrepareCommit,
  GitError,
} from './git.js';

const SEP = '\u001e';

describe('injectCredentialsInUrl', () => {
  it('injects user:pass into an https url', () => {
    expect(injectCredentialsInUrl('https://host.example/repo.git', { username: 'u', password: 'p' })).toBe(
      'https://u:p@host.example/repo.git'
    );
  });
  it('url-encodes special characters', () => {
    expect(
      injectCredentialsInUrl('https://host.example/r.git', { username: 'a b', password: 'c/d' })
    ).toBe('https://a%20b:c%2Fd@host.example/r.git');
  });
  it('replaces existing userinfo', () => {
    expect(
      injectCredentialsInUrl('https://old@host.example/r.git', { username: 'new', password: 'x' })
    ).toBe('https://new:x@host.example/r.git');
  });
  it('leaves ssh urls untouched', () => {
    expect(injectCredentialsInUrl('git@host.example:repo.git', { username: 'u' })).toBe(
      'git@host.example:repo.git'
    );
  });
  it('leaves url untouched without credentials', () => {
    expect(injectCredentialsInUrl('https://host.example/r.git', {})).toBe('https://host.example/r.git');
  });
});

describe('parseGitLogOutput', () => {
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  const sample = [
    `${SEP}${sha1}`,
    '张三',
    'zhangsan@example.com',
    '2026-11-15T10:00:00+08:00',
    'fix: 修复 engine 问题',
    'src/core/engine.cpp',
    'docs/读 文件.md',
    `${SEP}${sha2}`,
    'lisi',
    'lisi@example.com',
    '2026-11-16T09:00:00+08:00',
    'feat: add feature',
    'src/main.c',
    `${SEP}`,
  ].join('\n');

  it('parses entries oldest-first with author/date/message', () => {
    const entries = parseGitLogOutput(sample);
    expect(entries).toHaveLength(2);
    expect(entries[0].sha).toBe(sha1);
    expect(entries[0].shortSha).toBe(sha1.slice(0, 7));
    expect(entries[0].authorName).toBe('张三');
    expect(entries[0].authorEmail).toBe('zhangsan@example.com');
    expect(entries[0].date).toBe('2026-11-15T10:00:00+08:00');
    expect(entries[0].message).toBe('fix: 修复 engine 问题');
    expect(entries[1].authorName).toBe('lisi');
  });

  it('parses changed files including names with spaces and Chinese', () => {
    const entries = parseGitLogOutput(sample);
    expect(entries[0].files).toEqual(['src/core/engine.cpp', 'docs/读 文件.md']);
  });

  it('returns empty for empty output', () => {
    expect(parseGitLogOutput('')).toEqual([]);
  });

  it('accepts NUL-separated file names from -z output', () => {
    const sha = 'c'.repeat(40);
    const out = [
      `${SEP}${sha}`,
      'author',
      'a@example.com',
      '2026-01-01T00:00:00+00:00',
      'msg',
      'file a.txt',
      '文件 b.txt',
      '',
      '',
    ].join('\u0000');
    const entries = parseGitLogOutput(out);
    expect(entries[0].files).toEqual(['file a.txt', '文件 b.txt']);
  });
});

// ---- Integration against a real local git repo (no network needed) ----

let workDir: string;
let repoDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'crp-git-'));
  repoDir = join(workDir, 'origin.git');
  mkdirSync(repoDir);
  const g = (args: string[]) => runGit(args, { cwd: repoDir });
  const seq = async () => {
    await g(['init', '-b', 'main']);
    await runGit(['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await runGit(['config', 'user.name', 'tester'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'a.txt'), 'hello\n');
    await g(['add', '.']);
    await g(['commit', '-m', 'first commit']);
    writeFileSync(join(repoDir, 'b.txt'), 'world\n');
    await g(['add', '.']);
    await g(['commit', '-m', 'second commit']);
  };
  return seq();
});

afterAll(async () => {
  // Windows: git processes may hold directory handles briefly; retry removal.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

describe('git integration (local repo)', () => {
  it('ls-remote lists refs of a local path', async () => {
    const { refs } = await gitLsRemote(repoDir);
    expect(refs.some((r) => r.ref === 'refs/heads/main')).toBe(true);
  });

  it('ls-remote fails with error for nonexistent repo', async () => {
    await expect(gitLsRemote(join(workDir, 'no-such.git'))).rejects.toThrow(GitError);
  });

  it('clone + log resolves commits oldest-first with files', async () => {
    const cloneDir = join(workDir, 'clone');
    await gitClone(repoDir, cloneDir);
    const { stdout } = await runGit(['rev-parse', 'main'], { cwd: cloneDir });
    const head = stdout.trim();
    // walk from empty tree: use first-parent root..main
    const entries = await gitLog(cloneDir, `${head}~1`, head);
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toContain('b.txt');
  });

  it('gitResolveSha resolves short sha uniquely', async () => {
    const { stdout } = await runGit(['rev-parse', 'main'], { cwd: repoDir });
    const full = stdout.trim();
    expect(await gitResolveSha(repoDir, full.slice(0, 7))).toBe(full);
    expect(await gitResolveSha(repoDir, 'deadbeef')).toBeNull();
  });

  it('fetch branch + prepare commit checks out the right content', async () => {
    const cloneDir = join(workDir, 'clone2');
    await gitClone(repoDir, cloneDir);
    const { stdout } = await runGit(['rev-parse', 'main'], { cwd: repoDir });
    const head = stdout.trim();
    await gitFetchBranch(cloneDir, repoDir, 'main');
    await gitPrepareCommit(cloneDir, repoDir, head);
    const { stdout: cat } = await runGit(['show', `${head}:b.txt`], { cwd: cloneDir });
    expect(cat).toBe('world\n');
  });
});
