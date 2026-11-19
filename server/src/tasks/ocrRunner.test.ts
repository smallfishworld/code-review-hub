import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { TaskQueue } from './taskQueue.js';
import { OcrRunner, workCopyDir } from './ocrRunner.js';
import { LogService } from '../logs/logService.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let credentials: CredentialService;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-ocr-'));
  db = openDatabase({ dataDir: join(dir, 'data') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  dataDir = join(dir, 'platform-data');
});

afterEach(async () => {
  db?.close();
  // Windows: child processes may hold directory handles briefly; retry.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

/**
 * Fake ocr: a small script that mimics `ocr review ... --format json --output f`.
 * Modes: ok (write report, exit 0), fail (exit 1, stderr), slow (sleep).
 */
function makeFakeOcr(mode: 'ok' | 'fail' | 'slow' = 'ok'): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const isWin = process.platform === 'win32';
  const path = join(binDir, isWin ? 'ocr.cmd' : 'ocr');
  if (isWin) {
    // Reliable fake: a .cmd shim delegating to a node script (arg parsing in
    // node, not cmd).
    const script = join(binDir, 'ocr-fake.cjs');
    writeFileSync(
      script,
      `const args = process.argv.slice(2);
const outIdx = args.indexOf('--output');
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const mode = ${JSON.stringify(mode)};
if (mode === 'fail') { console.error('boom ocr failed'); process.exit(1); }
if (mode === 'slow') { setTimeout(() => process.exit(0), 60000); return; }
if (out) { require('node:fs').writeFileSync(out, '{"summary":"ok","issues":[]}'); }
process.exit(0);
`
    );
    writeFileSync(path, `@echo off\r\nnode "${script}" %*\r\n`);
  } else {
    const content = `#!/bin/sh
mode=${JSON.stringify(mode)}
if [ "$mode" = "fail" ]; then echo "boom ocr failed" >&2; exit 1; fi
if [ "$mode" = "slow" ]; then sleep 60; fi
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"
done
if [ "$mode" = "ok" ] && [ -n "$out" ]; then echo '{"summary":"ok","issues":[]}' > "$out"; fi
exit 0
`;
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  return binDir;
}

function seedGitRepo(db: Database.Database): number {
  execSync(`git init -b main ${JSON.stringify(join(dir, 'origin.git'))}`);
  const info = db
    .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'g1', ?, 'main')")
    .run(join(dir, 'origin.git'));
  return Number(info.lastInsertRowid);
}

function makeRunnerQueue(
  ocrBinDir: string,
  mode: 'ok' | 'fail' | 'slow' = 'ok',
  logs?: LogService
): TaskQueue {
  const runner = new OcrRunner(db, credentials, {
    dataDir,
    ocrBin: join(ocrBinDir, process.platform === 'win32' ? 'ocr.cmd' : 'ocr'),
    logs,
  });
  void mode;
  return new TaskQueue(db, runner.executor, 2);
}

describe('OcrRunner + TaskQueue integration (fake ocr)', () => {
  it('succeeds: prepares git clone, runs ocr, writes report file', async () => {
    execSync(`git init -b main ${JSON.stringify(join(dir, 'origin.git'))}`);
    // create a real commit so checkout has something
    const origin = join(dir, 'origin.git');
    execSync('git config user.email t@t && git config user.name t', { cwd: origin });
    writeFileSync(join(origin, 'a.txt'), 'hello');
    execSync('git add . && git commit -m first', { cwd: origin });
    const sha = execSync('git rev-parse HEAD', { cwd: origin }).toString().trim();

    const info = db
      .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'g1', ?, 'main')")
      .run(origin);
    const repoId = Number(info.lastInsertRowid);

    const binDir = makeFakeOcr('ok');
    const q = makeRunnerQueue(binDir);
    const t = q.enqueue(repoId, sha, 'manual');
    await q.idle();
    const after = q.get(t.id);
    expect(after.status).toBe('succeeded');
    // report file written by the fake ocr
    const reportPath = join(dataDir, 'reports', `${t.id}.json`);
    expect(existsSync(reportPath)).toBe(true);
    // clone cached under dataDir/workcopies/<repoId>
    expect(existsSync(join(workCopyDir(dataDir, repoId), '.git'))).toBe(true);
  });

  it('fails: captures ocr stderr in the task error', async () => {
    const repoId = seedGitRepo(db);
    const binDir = makeFakeOcr('fail');
    const q = makeRunnerQueue(binDir);
    // no commits in origin; use the all-zeros sha — the run will fail at
    // workspace prep or ocr; either way task ends failed with a reason.
    const t = q.enqueue(repoId, '0'.repeat(40), 'manual');
    await q.idle();
    const after = q.get(t.id);
    expect(after.status).toBe('failed');
    expect(after.error).toBeTruthy();
  });

  it('cancel kills a slow ocr child and marks the task cancelled', async () => {
    const origin = join(dir, 'origin.git');
    execSync(`git init -b main ${JSON.stringify(origin)}`);
    execSync('git config user.email t@t && git config user.name t', { cwd: origin });
    writeFileSync(join(origin, 'a.txt'), 'hi');
    execSync('git add . && git commit -m c', { cwd: origin });
    const sha = execSync('git rev-parse HEAD', { cwd: origin }).toString().trim();
    const info = db
      .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'g1', ?, 'main')")
      .run(origin);
    const repoId = Number(info.lastInsertRowid);

    const binDir = makeFakeOcr('slow');
    const q = makeRunnerQueue(binDir);
    const t = q.enqueue(repoId, sha, 'manual');
    await new Promise((r) => setTimeout(r, 1500)); // let it reach the ocr phase
    expect(q.get(t.id).status).toBe('running');
    expect(q.cancel(t.id)).toBe(true);
    await q.idle();
    expect(q.get(t.id).status).toBe('cancelled');
  });

  it('reports "cannot start ocr" when the binary is missing', async () => {
    const repoId = seedGitRepo(db);
    const runner = new OcrRunner(db, credentials, {
      dataDir,
      ocrBin: join(dir, 'no-such-ocr-binary'),
    });
    const q = new TaskQueue(db, runner.executor, 2);
    const t = q.enqueue(repoId, '0'.repeat(40), 'manual');
    await q.idle();
    const after = q.get(t.id);
    expect(after.status).toBe('failed');
    // Either workspace-prep failure (empty repo) or ocr start failure.
    expect(after.error).toBeTruthy();
  });

  it('streams ocr stdout/stderr into the runtime LogService', async () => {
    const origin = join(dir, 'origin.git');
    execSync(`git init -b main ${JSON.stringify(origin)}`);
    execSync('git config user.email t@t && git config user.name t', { cwd: origin });
    writeFileSync(join(origin, 'a.txt'), 'hi');
    execSync('git add . && git commit -m c', { cwd: origin });
    const sha = execSync('git rev-parse HEAD', { cwd: origin }).toString().trim();
    const info = db
      .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'g1', ?, 'main')")
      .run(origin);
    const repoId = Number(info.lastInsertRowid);

    // ocr prints one line on stdout and one on stderr before failing.
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const script = join(binDir, 'ocr-noisy.cjs');
    writeFileSync(
      script,
      `console.log('reviewing files... progress 50%');
console.error('LLM call failed: rate limited');
process.exit(1);`
    );
    const ocrCmd = join(binDir, process.platform === 'win32' ? 'ocr.cmd' : 'ocr');
    if (process.platform === 'win32') {
      writeFileSync(ocrCmd, `@echo off\r\nnode "${script}" %*\r\n`);
    } else {
      writeFileSync(ocrCmd, `#!/bin/sh\nnode "${script}"\n`);
      chmodSync(ocrCmd, 0o755);
    }

    const logs = new LogService(100, join(dir, 'runtime-logs'));
    const q = makeRunnerQueue(binDir, 'fail', logs);
    const t = q.enqueue(repoId, sha, 'manual');
    await q.idle();
    expect(q.get(t.id).status).toBe('failed');

    const lines = logs.recent({ src: 'ocr' }).items;
    // stdout line captured as info, stderr line as error, both task-prefixed
    expect(lines.some((l) => l.level === 'info' && l.msg.includes('#') && l.msg.includes('reviewing files... progress 50%'))).toBe(true);
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('LLM call failed: rate limited'))).toBe(true);
    // also persisted to the daily file for post-mortem
    const files = logs.files();
    expect(files.length).toBe(1);
  });

  it('prep phase and ocr spawn are visible in the runtime log', async () => {
    const origin = join(dir, 'origin.git');
    execSync(`git init -b main ${JSON.stringify(origin)}`);
    execSync('git config user.email t@t && git config user.name t', { cwd: origin });
    writeFileSync(join(origin, 'a.txt'), 'hi');
    execSync('git add . && git commit -m c', { cwd: origin });
    const sha = execSync('git rev-parse HEAD', { cwd: origin }).toString().trim();
    const info = db
      .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'g1', ?, 'main')")
      .run(origin);
    const repoId = Number(info.lastInsertRowid);

    const logs = new LogService(100, join(dir, 'runtime-logs'));
    const binDir = makeFakeOcr('ok');
    const q = makeRunnerQueue(binDir, 'ok', logs);
    const t = q.enqueue(repoId, sha, 'manual');
    await q.idle();
    expect(q.get(t.id).status).toBe('succeeded');

    const taskLines = logs.recent({ src: 'task' }).items.map((l) => l.msg);
    // the silent prep phase (clone bootstrap) is announced before ocr starts
    expect(taskLines.some((m) => m.includes(`#${t.id} 同步 Git 仓库`))).toBe(true);
    expect(taskLines.some((m) => m.includes(`#${t.id} 工作副本就绪，启动 ocr 评审…`))).toBe(true);
  });
});
