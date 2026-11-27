import Fastify from 'fastify';
import { checkDependencies, formatReport } from './deps/detector.js';
import { openDatabase } from './db/database.js';
import { SecretStore } from './crypto/secrets.js';
import { CredentialService } from './crypto/credentialService.js';
import { buildRepoRoutes } from './repos/repoRoutes.js';
import { TaskQueue } from './tasks/taskQueue.js';
import { ReportService } from './tasks/reportService.js';
import { scrubCachedGitCredentials } from './vcs/git.js';
import { TaskEventHub } from './tasks/taskEvents.js';
import { buildTaskRoutes } from './tasks/taskRoutes.js';
import { WorkspaceInitService } from './tasks/workspaceInit.js';
import { EngineExecutor } from './engines/executor.js';
import { bootstrapEngines } from './engines/registry.js';
import { buildEngineRoutes } from './engines/routes.js';
import { buildMcpRoutes } from './mcp/routes.js';
import { ensureBuiltinCodeGraph, ensureBuiltinMemoryQuery } from './mcp/injector.js';
import { buildMemoryRoutes } from './memory/routes.js';
import { MonitorService } from './monitor/monitorService.js';
import { buildMonitorRoutes } from './monitor/monitorRoutes.js';
import { buildProviderRoutes } from './providers/providerRoutes.js';
import { buildNotificationRoutes } from './notifications/notificationRoutes.js';
import { buildShareRoutes } from './share/shareRoutes.js';
import { buildAuthRoutes } from './auth/authRoutes.js';
import { LogService } from './logs/logService.js';
import { buildLogRoutes } from './logs/logRoutes.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { browserUrl, shouldOpenBrowser, openBrowser } from './startup/browser.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const maxReviewConcurrency = Number(process.env.REVIEW_MAX_CONCURRENCY ?? 4);
/** Set AUTH_REQUIRED=false to disable the admin-password guard. */
const authRequired = process.env.AUTH_REQUIRED !== 'false';

/** Runtime log sink shared by every service and the web console. */
const logs = new LogService(5000, dataDir);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Mirror pino output into the runtime log so the web console sees HTTP
    // errors too. request-level info lines are noisy at debug; keep them out.
    stream: {
      write(msg: string) {
        try {
          const row = JSON.parse(msg) as { level?: number; msg?: string; err?: { message?: string } };
          const level = row.level === 50 ? 'error' : row.level === 40 ? 'warn' : 'info';
          if (level === 'info' && row.msg === 'request completed') return;
          const text = row.err?.message ? `${row.msg}: ${row.err.message}` : (row.msg ?? msg.trim());
          logs.log(level, 'server', text);
        } catch {
          logs.info('server', msg.trim());
        }
      },
    },
  },
});

/** Locate the built SPA (web/dist) relative to the repo root. */
function findWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../web/dist'), // server/dist -> repo/web/dist
    resolve(here, '../../../web/dist'), // server/src -> repo/web/dist (tsx)
    resolve(process.cwd(), 'web/dist'),
  ];
  return candidates.find((p) => existsSync(join(p, 'index.html'))) ?? null;
}

async function main() {
  if (!Number.isSafeInteger(maxReviewConcurrency) || maxReviewConcurrency < 1) {
    throw new Error('REVIEW_MAX_CONCURRENCY 必须是正整数');
  }
  // Startup dependency check: svn/git are conditional (per repo type),
  // ocr is required for reviews.
  const depReport = await checkDependencies();
  app.log.info(formatReport(depReport));
  logs.info('server', `服务启动 (data: ${dataDir})`);

  // --- core services -------------------------------------------------------
  const db = openDatabase({ dataDir });
  await scrubCachedGitCredentials(dataDir, (cache) => {
    logs.warn('server', `无法清理 Git 缓存凭据: ${cache}`);
  });
  const credentials = new CredentialService(db, new SecretStore(join(dataDir, 'keys')));
  bootstrapEngines(db); // 幂等：空库插入默认 ocr 引擎并设为全局默认
  ensureBuiltinMemoryQuery(db); // 幂等：内置记忆查询 MCP 桥（system 行，管理员可停用）
  ensureBuiltinCodeGraph(db);
  const engineExecutor = new EngineExecutor(db, credentials, { dataDir, logs });
  const reports = new ReportService(db);
  reports.recoverLegacyIndexes(dataDir);
  const queue = new TaskQueue(db, engineExecutor.execute, maxReviewConcurrency, logs, reports);
  const events = new TaskEventHub(db, queue, reports, dataDir, credentials);
  events.start();

  const monitor = new MonitorService(db, credentials, queue, { dataDir, logs });
  const workspaceInit = new WorkspaceInitService(db, credentials, dataDir, logs);

  // --- HTTP routes ---------------------------------------------------------
  // Auth guard first: it hooks onRequest for /api/*.
  buildAuthRoutes(db, { loginRequired: authRequired }).register(app);

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/deps', async () => depReport);
  app.post('/api/deps/check', async () => checkDependencies());

  buildRepoRoutes(db, credentials, {
    onRepoChange: (repoId) => {
      monitor.syncRepo(repoId);
      queue.kick();
    },
    cancelRepoTasks: (repoId) => {
      const n = queue.cancelByRepo(repoId);
      if (n > 0) logs.info('task', `仓库 #${repoId} 已删除，取消其 ${n} 个未完成任务`);
    },
    dataDir,
    workspaceInit,
  }).register(app);
  buildTaskRoutes(db, credentials, queue, dataDir).register(app);
  const share = buildShareRoutes(db, reports, {
    baseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    dataDir,
  });
  share.register(app);
  buildMonitorRoutes(db, monitor).register(app);
  buildLogRoutes(logs).register(app);
  buildProviderRoutes(db, credentials).register(app);
  buildEngineRoutes(db, credentials, { dataDir }).register(app);
  buildMcpRoutes(db).register(app);
  buildMemoryRoutes(db, credentials, dataDir).register(app);
  const notifications = buildNotificationRoutes(db, credentials, {
    reports,
    senderOptions: {
      baseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
      // Pushed links point at the read-only share page, not the console.
      shareUrlFor: share.shareUrlFor,
    },
  });
  notifications.register(app);
  notifications.sender?.start(events);

  // --- static SPA (production build) ---------------------------------------
  const webDist = findWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // SPA fallback: any non-API GET returns index.html so client routes work
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ message: 'Not Found' });
    });
    app.log.info(`serving web console from ${webDist}`);
  } else {
    app.log.warn('web/dist not found — run `npm run build:web` to serve the console');
  }

  // --- startup recovery ----------------------------------------------------
  queue.recoverFromRestart();
  monitor.start();

  app.addHook('onClose', async () => {
    monitor.stop();
    queue.stop();
    db.close();
  });

  await app.listen({ port, host });
  app.log.info(`code review platform listening on http://${host}:${port} (data: ${dataDir})`);
  if (webDist && shouldOpenBrowser(process.env, process.platform, Boolean(process.stdout.isTTY), process.argv.includes('--open-browser'))) {
    const address = app.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    openBrowser(browserUrl(host, actualPort), (message) => logs.warn('server', `Browser launch failed: ${message}`));
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
