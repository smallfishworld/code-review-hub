#!/usr/bin/env node
/**
 * Cross-platform smoke test (tasks 8.1 / 8.3).
 *
 * Drives a platform instance through the full flow:
 *   启动 → 配置 SVN 与 Git 仓库 → 手动单节点/区间评审 → 自动监控（人员/路径过滤）
 *   → 通知（聊天 + 邮件，成功/失败/仅失败规则）→ 查看报告 → 服务重启恢复
 *
 * The script creates its own throwaway SVN and Git repositories (svnadmin /
 * git required), a local webhook receiver and a local SMTP stub, so it runs
 * identically on Windows and Linux:
 *
 *   node scripts/smoke.mjs
 *
 * Environment:
 *   BASE_URL        platform base URL (default http://127.0.0.1:3000)
 *   SMOKE_DIR       scratch dir (default: <tmp>/crp-smoke-<timestamp>)
 *   ADMIN_PASSWORD  admin password to set/use (default: smoke-admin-123)
 *   SMOKE_LLM_BASE / SMOKE_LLM_MODEL / SMOKE_LLM_KEY / SMOKE_LLM_PROTOCOL
 *                   optional provider to create (otherwise ocr's own config
 *                   is used)
 *   SMOKE_TIMEOUT_MS  per-review wait (default 20 min)
 *   SMOKE_KEEP=1    keep the scratch dir
 *
 * Service-restart recovery (phase 10) needs to own the server process:
 *   SMOKE_SERVER_CMD   command that starts the platform, e.g. "node server/dist/index.js"
 *   SMOKE_SERVER_CWD   working dir for that command (default: cwd)
 *   SMOKE_DATA_DIR     DATA_DIR to pass to the server (required with SERVER_CMD)
 * Without SMOKE_SERVER_CMD the restart phase is reported as skipped.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'smoke-admin-123';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 20 * 60_000);
const SCRATCH = process.env.SMOKE_DIR ?? join(tmpdir(), `crp-smoke-${Date.now()}`);
const KEEP = process.env.SMOKE_KEEP === '1';

const SERVER_CMD = process.env.SMOKE_SERVER_CMD ?? '';
const SERVER_CWD = process.env.SMOKE_SERVER_CWD ?? process.cwd();
const SERVER_DATA_DIR = process.env.SMOKE_DATA_DIR ?? '';
const SERVER_LOG = join(SCRATCH, 'server.log');

let token = null;
const results = [];

function log(step, detail = '') {
  console.log(`\n=== ${step}${detail ? ` — ${detail}` : ''}`);
}
function ok(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && parsed.message
        ? parsed.message
        : `HTTP ${res.status} ${text.slice(0, 200)}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function makeSvnRepo() {
  const repoDir = join(SCRATCH, 'svn-repo');
  const wcDir = join(SCRATCH, 'svn-wc');
  mkdirSync(repoDir, { recursive: true });
  sh('svnadmin', ['create', repoDir]);
  const url = 'file:///' + repoDir.replaceAll('\\', '/');
  sh('svn', ['checkout', url, wcDir]);
  mkdirSync(join(wcDir, 'trunk', 'src'), { recursive: true });
  writeFileSync(join(wcDir, 'trunk', 'src', 'calc.c'), 'int add(int a,int b){return a+b;}\n');
  sh('svn', ['add', '--force', '.'], wcDir);
  sh('svn', ['commit', '-m', 'init', '--username', 'smoke'], wcDir);
  writeFileSync(join(wcDir, 'trunk', 'src', 'calc.c'), 'int add(int a,int b){return a-b;}\n');
  sh('svn', ['commit', '-m', 'bug: subtraction', '--username', 'smoke'], wcDir);
  return { url, wcDir };
}

function makeGitRepo() {
  const dir = join(SCRATCH, 'git-origin');
  mkdirSync(dir, { recursive: true });
  sh('git', ['init', '-b', 'main', dir]);
  sh('git', ['config', 'user.email', 'smoke@example.com'], dir);
  sh('git', ['config', 'user.name', 'smoke'], dir);
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b;\n');
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-m', 'init'], dir);
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b;\n');
  sh('git', ['add', '.'], dir);
  sh('git', ['commit', '-m', 'bug: subtraction'], dir);
  const sha = sh('git', ['rev-parse', 'HEAD'], dir).trim();
  return { url: dir, dir, sha };
}

/** Add a commit to the scratch git repo; returns the new sha. */
function commitGit(repo, message, content) {
  writeFileSync(join(repo.dir, 'app.js'), content);
  sh('git', ['add', '.'], repo.dir);
  sh('git', ['commit', '-m', message], repo.dir);
  return sh('git', ['rev-parse', 'HEAD'], repo.dir).trim();
}

function startWebhook() {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Minimal SMTP server: enough for nodemailer to deliver messages. */
function startSmtpStub() {
  const messages = [];
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 smoke ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          messages.push(data);
          data = '';
          inData = false;
          socket.write('250 OK queued\r\n');
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-smoke\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'HELO') socket.write('250 smoke\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

// --- server process management (restart recovery) ---------------------------

let serverProc = null;
let serverExit = null;

function startServerProcess() {
  const port = String(new URL(BASE).port || 80);
  const out = createWriteStream(SERVER_LOG, { flags: 'a' });
  const child = spawn(SERVER_CMD, {
    shell: true,
    cwd: SERVER_CWD,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      DATA_DIR: SERVER_DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', (code, signal) => {
    serverExit = { code, signal };
  });
  return child;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExit) {
      let tail = '';
      try {
        tail = readFileSync(SERVER_LOG, 'utf8').slice(-1500);
      } catch {
        /* no log yet */
      }
      throw new Error(`server exited (code=${serverExit.code}) before becoming healthy:\n${tail}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function startServer() {
  serverExit = null;
  serverProc = startServerProcess();
  await waitForHealth(90_000);
}

async function stopServer() {
  const child = serverProc;
  if (!child) return;
  serverProc = null;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.once('exit', finish);
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    }
    setTimeout(finish, 15_000);
  });
}

async function restartServer() {
  await stopServer();
  serverExit = null;
  await startServer();
}

// --- waits ------------------------------------------------------------------

async function waitForTask(taskId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const task = await api('GET', `/api/tasks/${taskId}`);
    last = task;
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`task ${taskId} did not finish in time (last status: ${last?.status})`);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForLogs(taskId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await api('GET', `/api/notifications/logs?taskId=${taskId}`);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  console.log(`platform: ${BASE}`);
  console.log(`scratch:  ${SCRATCH}`);

  if (SERVER_CMD) {
    if (!SERVER_DATA_DIR) throw new Error('SMOKE_SERVER_CMD requires SMOKE_DATA_DIR');
    await startServer();
    console.log(`server:   started by smoke (${SERVER_CMD}), log ${SERVER_LOG}`);
  }

  // 1. health + auth --------------------------------------------------------
  log('1/10 启动检查');
  const health = await api('GET', '/api/health');
  ok('服务健康', health.status);
  const deps = await api('GET', '/api/deps');
  for (const dep of deps.results) {
    const label = `${dep.command} ${dep.found && dep.executable ? '可用' : '不可用'}`;
    if (dep.command === 'ocr' && !(dep.found && dep.executable)) fail(label, dep.error);
    else ok(label, dep.version ?? dep.error ?? '');
  }

  const auth = await api('GET', '/api/auth/status');
  if (!auth.loginRequired) {
    await api('POST', '/api/auth/password', { password: ADMIN_PASSWORD });
    ok('首次设置管理员口令');
  }
  const login = await api('POST', '/api/auth/login', {
    username: 'admin',
    password: ADMIN_PASSWORD,
  });
  token = login.token;
  ok('管理员登录', `token ${token.slice(0, 8)}…`);
  try {
    await api('GET', '/api/repos');
    ok('鉴权生效（已登录可访问）');
  } catch {
    fail('鉴权生效（已登录可访问）');
  }

  // 2. provider (optional) --------------------------------------------------
  log('2/10 LLM Provider');
  let goodProvider = null;
  if (process.env.SMOKE_LLM_BASE) {
    const providers = await api('GET', '/api/providers');
    const existing = providers.find((p) => p.name === 'smoke-provider');
    const payload = {
      name: 'smoke-provider',
      apiBase: process.env.SMOKE_LLM_BASE,
      model: process.env.SMOKE_LLM_MODEL ?? 'smoke-model',
      protocol: process.env.SMOKE_LLM_PROTOCOL ?? 'anthropic',
      apiKey: process.env.SMOKE_LLM_KEY || undefined,
    };
    goodProvider = existing
      ? await api('PUT', `/api/providers/${existing.id}`, payload)
      : await api('POST', '/api/providers', payload);
    await api('POST', `/api/providers/${goodProvider.id}/default`);
    ok('Provider 已配置并设为默认', `${goodProvider.apiBase} / ${goodProvider.model}`);
  } else {
    ok('跳过 Provider 配置（使用 ocr 自身配置）');
  }

  // 3. notification channels ------------------------------------------------
  log('3/10 通知渠道（聊天 + 邮件）');
  const webhook = await startWebhook();
  const smtp = await startSmtpStub();
  const channels = await api('GET', '/api/notifications/channels');
  const ensureChannel = async (payload) => {
    const existing = channels.find((c) => c.name === payload.name);
    return existing
      ? api('PUT', `/api/notifications/channels/${existing.id}`, payload)
      : api('POST', '/api/notifications/channels', payload);
  };

  const chatChannel = await ensureChannel({
    type: 'chat',
    name: 'smoke-bot',
    webhookUrl: webhook.url,
    template:
      '【代码评审】{{repo}} {{node}} {{status}}\n作者：{{author}}\n摘要：{{summary}}\n报告：{{report_url}}',
    enabled: true,
  });
  await api('POST', `/api/notifications/channels/${chatChannel.id}/enable`);
  const chatTest = await api('POST', `/api/notifications/channels/${chatChannel.id}/test`);
  ok('聊天机器人渠道已启用并测试发送', chatTest.message);

  const emailChannel = await ensureChannel({
    type: 'email',
    name: 'smoke-mail',
    host: '127.0.0.1',
    port: smtp.port,
    secure: false,
    from: 'smoke@example.com',
    to: ['dev@example.com'],
    username: 'smoke',
    password: 'smoke-secret',
    enabled: true,
  });
  await api('POST', `/api/notifications/channels/${emailChannel.id}/enable`);
  const mailTest = await api('POST', `/api/notifications/channels/${emailChannel.id}/test`);
  await waitFor(() => smtp.messages.length >= 1, 30_000, '测试邮件');
  ok('邮件渠道已启用并测试发送', `${mailTest.message}（SMTP 已收到 ${smtp.messages.length} 封）`);

  await api('PUT', '/api/notifications/trigger', { trigger: 'all' });
  ok('触发规则：全部完成');

  // 4. repos ----------------------------------------------------------------
  log('4/10 配置仓库');
  const svn = makeSvnRepo();
  const git = makeGitRepo();
  ok('本地测试仓库已创建', 'svn r1-r2 / git 2 commits');

  const repos = await api('GET', '/api/repos');
  const ensureRepo = async (payload) => {
    const existing = repos.find((r) => r.name === payload.name);
    return existing
      ? api('PUT', `/api/repos/${existing.id}`, payload)
      : api('POST', '/api/repos', payload);
  };
  const svnRepo = await ensureRepo({ type: 'svn', name: 'smoke-svn', url: svn.url });
  ok('SVN 仓库已保存（连通性验证通过）', `#${svnRepo.id}`);
  const gitRepo = await ensureRepo({
    type: 'git',
    name: 'smoke-git',
    url: git.url,
    branch: 'main',
  });
  ok('Git 仓库已保存（连通性验证通过）', `#${gitRepo.id}`);

  // 5. manual review --------------------------------------------------------
  log('5/10 手动触发评审');
  const svnTask = await api('POST', `/api/repos/${svnRepo.id}/review`, { node: '2' });
  ok('SVN 单节点任务已创建', `#${svnTask.task.id} r2`);
  const svnDone = await waitForTask(svnTask.task.id);
  if (svnDone.status === 'succeeded') ok('SVN 评审完成', `#${svnDone.id}`);
  else fail('SVN 评审完成', `${svnDone.status}: ${svnDone.error ?? ''}`);

  const gitTask = await api('POST', `/api/repos/${gitRepo.id}/review`, { node: git.sha });
  ok('Git 单节点任务已创建', `#${gitTask.task.id} ${git.sha.slice(0, 8)}`);
  const gitDone = await waitForTask(gitTask.task.id);
  if (gitDone.status === 'succeeded') ok('Git 评审完成', `#${gitDone.id}`);
  else fail('Git 评审完成', `${gitDone.status}: ${gitDone.error ?? ''}`);

  const range = await api('POST', `/api/repos/${svnRepo.id}/review-range`, {
    from: '1',
    to: '2',
  });
  ok('SVN 区间任务已创建', `${range.tasks.length} 个`);
  for (const t of range.tasks) await waitForTask(t.id);
  ok('SVN 区间任务全部完成');

  // 6. report ---------------------------------------------------------------
  log('6/10 查看报告');
  const byType = await api('GET', '/api/tasks?repoType=svn&limit=200');
  if (byType.total > 0 && byType.items.every((t) => t.repoId === svnRepo.id))
    ok('任务列表按仓库类型过滤', `SVN ${byType.total} 个`);
  else fail('任务列表按仓库类型过滤', JSON.stringify(byType.items.slice(0, 3)));
  for (const [label, task] of [
    ['SVN', svnDone],
    ['Git', gitDone],
  ]) {
    if (task.status !== 'succeeded') {
      fail(`${label} 报告`, '任务未成功');
      continue;
    }
    try {
      const report = await api('GET', `/api/tasks/${task.id}/report`);
      ok(
        `${label} 报告可读`,
        `${report.report.issueCount} 条问题 / ${report.report.parsedOk ? '已解析' : '仅原文'}`
      );
      if (report.report.issueCount > 0) {
        const issue = report.issues[0];
        const fields = ['file', 'line', 'severity', 'description'];
        const missing = fields.filter((f) => issue[f] === null || issue[f] === undefined);
        if (missing.length === 0) ok(`${label} 问题含文件/行号/级别/描述`);
        else fail(`${label} 问题含文件/行号/级别/描述`, `缺少 ${missing.join(',')}`);
        if (typeof issue.suggestion === 'string' && issue.suggestion.length > 0)
          ok(`${label} 问题含建议代码`, issue.suggestion.slice(0, 40));
        else ok(`${label} 问题无建议代码`, 'ocr 未给出 suggestion_code');
      }
    } catch (err) {
      fail(`${label} 报告`, err.message);
    }
  }

  // 7. notification delivery ------------------------------------------------
  log('7/10 通知投递（聊天 + 邮件）');
  try {
    await waitFor(() => webhook.received.length >= 2, 60_000, 'webhook 通知');
    ok('Webhook 收到通知', `${webhook.received.length} 条`);
    const texts = webhook.received.map((r) => {
      try {
        const parsed = JSON.parse(r.body);
        return typeof parsed === 'string' ? parsed : parsed.text ?? JSON.stringify(parsed);
      } catch {
        return r.body;
      }
    });
    if (texts.some((t) => /smoke-(svn|git)/.test(t))) ok('聊天通知内容包含仓库名');
    else fail('聊天通知内容包含仓库名', texts.join(' | ').slice(0, 160));
  } catch (err) {
    fail('Webhook 收到通知', err.message);
  }
  try {
    await waitFor(() => smtp.messages.length >= 2, 60_000, '评审邮件');
    ok('SMTP 收到评审邮件', `${smtp.messages.length} 封`);
    if (smtp.messages.some((m) => /smoke-(svn|git)/.test(m))) ok('邮件正文包含仓库名');
    else fail('邮件正文包含仓库名', smtp.messages.at(-1)?.slice(0, 200));
  } catch (err) {
    fail('SMTP 收到评审邮件', err.message);
  }
  const logs = await api('GET', '/api/notifications/logs?limit=20');
  const sent = logs.filter((l) => l.status === 'sent');
  if (sent.length > 0) ok('通知日志记录成功', `${sent.length} 条`);
  else fail('通知日志记录成功', JSON.stringify(logs.slice(0, 3)));

  // 8. monitoring -----------------------------------------------------------
  log('8/10 自动监控');
  await api('PUT', `/api/monitor/rules/${svnRepo.id}`, {
    intervalSeconds: 60,
    authorWhitelist: ['smoke'],
    pathPrefixes: ['trunk/src/'],
    backtrackNodes: 0,
  });
  await api('POST', `/api/monitor/rules/${svnRepo.id}/enable`);
  ok('监控规则已启用（作者+路径过滤）');

  writeFileSync(join(svn.wcDir, 'trunk', 'src', 'calc.c'), 'int add(int a,int b){return a+b;}\n');
  sh('svn', ['commit', '-m', 'fix: addition', '--username', 'smoke'], svn.wcDir);
  await api('POST', `/api/monitor/rules/${svnRepo.id}/poll`);
  const status = (await api('GET', '/api/monitor/status')).find((s) => s.repoId === svnRepo.id);
  if (status?.recentLog?.some((l) => l.action === 'triggered'))
    ok('监控触发新节点', `位置 ${status.lastNode}`);
  else fail('监控触发新节点', JSON.stringify(status?.recentLog?.slice(0, 3)));
  if (status?.headNode && status.headNode === status.lastNode)
    ok('监控状态显示最新节点', `headNode=${status.headNode}`);
  else fail('监控状态显示最新节点', `headNode=${status?.headNode} lastNode=${status?.lastNode}`);

  // filtered-out commit
  writeFileSync(join(svn.wcDir, 'trunk', 'README.md'), 'docs\n');
  sh('svn', ['add', '--force', '.'], svn.wcDir);
  sh('svn', ['commit', '-m', 'docs only', '--username', 'smoke'], svn.wcDir);
  await api('POST', `/api/monitor/rules/${svnRepo.id}/poll`);
  const status2 = (await api('GET', '/api/monitor/status')).find((s) => s.repoId === svnRepo.id);
  if (status2?.recentLog?.some((l) => l.action === 'skipped')) ok('路径过滤跳过记录', 'docs only');
  else fail('路径过滤跳过记录', JSON.stringify(status2?.recentLog?.slice(0, 3)));

  // 9. trigger rules + failure notification ---------------------------------
  log('9/10 通知触发规则与失败通知');
  const providers = await api('GET', '/api/providers');
  const badExisting = providers.find((p) => p.name === 'smoke-bad-provider');
  const badPayload = {
    name: 'smoke-bad-provider',
    apiBase: 'http://127.0.0.1:9',
    model: 'smoke-model',
    protocol: 'anthropic',
    apiKey: 'dummy',
  };
  const badProvider = badExisting
    ? await api('PUT', `/api/providers/${badExisting.id}`, badPayload)
    : await api('POST', '/api/providers', badPayload);

  await api('PUT', '/api/notifications/trigger', { trigger: 'failed_only' });
  ok('触发规则切换为：仅失败');

  const failSha = commitGit(git, 'bug: divide by zero', 'export const div = (a, b) => a / b;\n');
  await api('POST', `/api/providers/${badProvider.id}/default`);
  const failTask = await api('POST', `/api/repos/${gitRepo.id}/review`, { node: failSha });
  const failDone = await waitForTask(failTask.task.id);
  if (failDone.status === 'failed') ok('评审失败任务已记录', failDone.error?.slice(0, 80) ?? '');
  else fail('评审失败任务已记录', `状态 ${failDone.status}`);

  const failLogs = await waitForLogs(
    failDone.id,
    (rows) => rows.filter((l) => l.status === 'sent').length >= 2,
    60_000
  );
  const sentTypes = new Set(failLogs.filter((l) => l.status === 'sent').map((l) => l.channelType));
  if (sentTypes.has('chat') && sentTypes.has('email')) ok('失败通知已投递（聊天 + 邮件）');
  else fail('失败通知已投递（聊天 + 邮件）', JSON.stringify(failLogs.slice(0, 4)));

  // restore a working provider, then a successful task must NOT notify
  if (goodProvider) await api('POST', `/api/providers/${goodProvider.id}/default`);
  else await api('DELETE', `/api/providers/${badProvider.id}`);
  ok('已恢复可用 Provider');

  const quietSha = commitGit(git, 'feat: multiply', 'export const mul = (a, b) => a * b;\n');
  const quietTask = await api('POST', `/api/repos/${gitRepo.id}/review`, { node: quietSha });
  const quietDone = await waitForTask(quietTask.task.id);
  if (quietDone.status === 'succeeded') ok('恢复后评审成功', `#${quietDone.id}`);
  else fail('恢复后评审成功', `${quietDone.status}: ${quietDone.error ?? ''}`);
  await new Promise((r) => setTimeout(r, 8000));
  const quietLogs = await api('GET', `/api/notifications/logs?taskId=${quietDone.id}`);
  if (quietLogs.length === 0) ok('仅失败规则下成功任务不通知');
  else fail('仅失败规则下成功任务不通知', JSON.stringify(quietLogs.slice(0, 3)));

  // success_only: a successful task must notify
  await api('PUT', '/api/notifications/trigger', { trigger: 'success_only' });
  const okSha = commitGit(git, 'feat: subtract', 'export const sub = (a, b) => a - b;\n');
  const okTask = await api('POST', `/api/repos/${gitRepo.id}/review`, { node: okSha });
  const okDone = await waitForTask(okTask.task.id);
  const okLogs = await waitForLogs(okDone.id, (rows) => rows.some((l) => l.status === 'sent'));
  if (okDone.status === 'succeeded' && okLogs.some((l) => l.status === 'sent'))
    ok('仅成功规则下成功任务已通知', `${okLogs.length} 条`);
  else fail('仅成功规则下成功任务已通知', `${okDone.status} / ${JSON.stringify(okLogs.slice(0, 3))}`);
  await api('PUT', '/api/notifications/trigger', { trigger: 'all' });
  ok('触发规则已恢复为：全部完成');

  // 10. service restart recovery -------------------------------------------
  log('10/10 服务重启恢复');
  if (!SERVER_CMD) {
    ok('跳过服务重启恢复', '未设置 SMOKE_SERVER_CMD');
  } else {
    const before = (await api('GET', '/api/monitor/status')).find((s) => s.repoId === svnRepo.id);
    const reportTaskId = svnDone.id;
    await restartServer();
    ok('服务已重启', SERVER_CMD);

    // sessions are in-memory: the old token is gone, log in again
    const relogin = await api('POST', '/api/auth/login', {
      username: 'admin',
      password: ADMIN_PASSWORD,
    });
    token = relogin.token;
    ok('重启后重新登录');

    const after = (await api('GET', '/api/monitor/status')).find((s) => s.repoId === svnRepo.id);
    if (after?.enabled && after.lastNode === before?.lastNode)
      ok('监控规则与位置持久化', `lastNode=${after.lastNode}`);
    else fail('监控规则与位置持久化', `${before?.lastNode} -> ${after?.lastNode}`);

    try {
      const report = await api('GET', `/api/tasks/${reportTaskId}/report`);
      ok('历史报告仍可读取', `${report.report.issueCount} 条问题`);
    } catch (err) {
      fail('历史报告仍可读取', err.message);
    }

    // monitoring keeps working after the restart
    writeFileSync(join(svn.wcDir, 'trunk', 'src', 'calc.c'), 'int sub(int a,int b){return a-b;}\n');
    sh('svn', ['commit', '-m', 'after restart', '--username', 'smoke'], svn.wcDir);
    await api('POST', `/api/monitor/rules/${svnRepo.id}/poll`);
    const status3 = (await api('GET', '/api/monitor/status')).find((s) => s.repoId === svnRepo.id);
    if (status3?.recentLog?.some((l) => l.action === 'triggered'))
      ok('重启后监控继续工作', `位置 ${status3.lastNode}`);
    else fail('重启后监控继续工作', JSON.stringify(status3?.recentLog?.slice(0, 3)));
  }

  await webhook.close();
  await smtp.close();
  await stopServer();
}

main()
  .catch(async (err) => {
    console.error('\nSMOKE FAILED:', err.message);
    results.push({ name: 'smoke run', ok: false, detail: err.message });
    try {
      await stopServer();
    } catch {
      /* best effort */
    }
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log('\n================ SUMMARY ================');
    console.log(`passed: ${results.filter((r) => r.ok).length}  failed: ${failed.length}`);
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
    if (!KEEP) {
      try {
        rmSync(SCRATCH, { recursive: true, force: true });
      } catch {
        // Windows may hold handles briefly; leaving the dir is harmless
      }
    }
    process.exit(failed.length === 0 ? 0 : 1);
  });
