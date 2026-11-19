import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { buildNotificationRoutes } from './notificationRoutes.js';
import { ChannelService } from './channelService.js';
import { EmailChannel, type SmtpSettings, type MailTransport } from './emailChannel.js';
import { ChatChannel } from './chatChannel.js';
import { NotificationSender } from './notificationSender.js';
import { ReportService } from '../tasks/reportService.js';
import { TaskEventHub } from '../tasks/taskEvents.js';
import { TaskQueue, type TaskRecord } from '../tasks/taskQueue.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let credentials: CredentialService;
let channels: ChannelService;
let reports: ReportService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-send-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  channels = new ChannelService(db, credentials);
  reports = new ReportService(db);
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Email channel whose transport records messages and can fail N times. */
function fakeEmail(failures = 0): {
  email: EmailChannel;
  sent: SmtpSettings[];
  attempts: () => number;
} {
  const sent: SmtpSettings[] = [];
  let count = 0;
  const email = new EmailChannel(channels, (settings) => {
    const transport: MailTransport = {
      async sendMail() {
        count++;
        if (count <= failures) throw new Error('SMTP 连接被拒绝');
        sent.push(settings);
      },
    };
    return transport;
  });
  return { email, sent, attempts: () => count };
}

/** Chat channel whose fetch records payloads and can fail N times. */
function fakeChat(failures = 0): {
  chat: ChatChannel;
  payloads: unknown[];
  attempts: () => number;
} {
  const payloads: unknown[] = [];
  let count = 0;
  const fetchImpl = (async (_url: string, init?: { body?: unknown }) => {
    count++;
    if (count <= failures) throw new Error('webhook 不可达');
    payloads.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { chat: new ChatChannel(channels, fetchImpl), payloads, attempts: () => count };
}

function addRepo(name = 'demo-repo'): number {
  const info = db.prepare("INSERT INTO repo (type, name, url) VALUES ('svn', ?, 'file:///x')").run(name);
  return Number(info.lastInsertRowid);
}

let nodeSeq = 0;

function addTask(repoId: number, status: 'succeeded' | 'failed', error?: string): TaskRecord {
  const node = String(++nodeSeq);
  const info = db
    .prepare(
      `INSERT INTO task (repo_id, node, trigger, status, author, error)
       VALUES (?, ?, 'manual', ?, 'zhangsan', ?)`
    )
    .run(repoId, node, status, error ?? null);
  return {
    id: Number(info.lastInsertRowid),
    repoId,
    node,
    trigger: 'manual',
    status,
    author: 'zhangsan',
    error,
    createdAt: new Date().toISOString(),
  };
}

function addChatChannel(name: string, enabled = true): number {
  const dto = channels.create({
    type: 'chat',
    name,
    webhookUrl: `https://chat.example.com/${name}`,
    enabled,
  });
  return dto.id;
}

function addEmailChannel(name: string, enabled = true): number {
  const dto = channels.create({
    type: 'email',
    name,
    host: 'smtp.example.com',
    port: 25,
    from: 'review@example.com',
    to: ['dev@example.com'],
    enabled,
  });
  return dto.id;
}

function sender(
  email: EmailChannel,
  chat: ChatChannel,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): NotificationSender {
  return new NotificationSender(db, channels, email, chat, reports, {
    baseUrl: 'http://crp.local',
    attempts: options.attempts,
    retryDelaysMs: [1, 1],
    sleep: options.sleep ?? (async () => {}),
  });
}

describe('notification sender', () => {
  it('sends to every enabled channel with a complete context', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    db.prepare(
      `INSERT INTO report (task_id, summary, issue_count, raw_path, parsed_ok)
       VALUES (?, '发现 2 条评审意见', 2, '/tmp/x.json', 1)`
    ).run(task.id);
    addChatChannel('bot');
    addEmailChannel('mail');
    addChatChannel('disabled-bot', false);

    const { email, sent } = fakeEmail();
    const { chat, payloads } = fakeChat();
    await sender(email, chat).notify(task);

    expect(sent).toHaveLength(1);
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { text: string };
    expect(payload.text).toContain('demo-repo');
    expect(payload.text).toContain(task.node);
    expect(payload.text).toContain('zhangsan');
    expect(payload.text).toContain('发现 2 条评审意见');
    expect(payload.text).toContain('http://crp.local/tasks/' + task.id);

    const logs = sender(email, chat).logs({ taskId: task.id });
    expect(logs.map((l) => l.status)).toEqual(['sent', 'sent']);
  });

  it('honours the failed_only trigger rule', async () => {
    const repoId = addRepo();
    channels.setTrigger('failed_only');
    const ok = addTask(repoId, 'succeeded');
    const bad = addTask(repoId, 'failed', 'ocr exited with 1');
    addChatChannel('bot');

    const { email } = fakeEmail();
    const { chat, payloads } = fakeChat();
    const s = sender(email, chat);
    await s.notify(ok);
    expect(payloads).toHaveLength(0);
    await s.notify(bad);
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { text: string }).text).toContain('ocr exited with 1');
  });

  it('honours the success_only trigger rule', async () => {
    const repoId = addRepo();
    channels.setTrigger('success_only');
    addChatChannel('bot');
    const { email } = fakeEmail();
    const { chat, payloads } = fakeChat();
    const s = sender(email, chat);
    await s.notify(addTask(repoId, 'failed', 'boom'));
    expect(payloads).toHaveLength(0);
    await s.notify(addTask(repoId, 'succeeded'));
    expect(payloads).toHaveLength(1);
  });

  it('retries a bounded number of times, then logs the failure', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    addChatChannel('bot');
    const { email } = fakeEmail();
    const { chat, attempts } = fakeChat(99); // always fails
    const s = sender(email, chat, { attempts: 3 });
    await s.notify(task);

    expect(attempts()).toBe(3); // 3 attempts total, no more
    const logs = s.logs({ taskId: task.id });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('failed');
    expect(logs[0].detail).toContain('3 次');
    expect(logs[0].detail).toContain('webhook 不可达');
  });

  it('recovers when a retry succeeds', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    addChatChannel('bot');
    const { email } = fakeEmail();
    const { chat, attempts, payloads } = fakeChat(2); // fails twice, then ok
    const s = sender(email, chat, { attempts: 3 });
    await s.notify(task);

    expect(attempts()).toBe(3);
    expect(payloads).toHaveLength(1);
    expect(s.logs({ taskId: task.id })[0].status).toBe('sent');
  });

  it('isolates failures: a throwing channel does not stop the others or the task', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    addChatChannel('broken');
    addEmailChannel('mail');

    const { email, sent } = fakeEmail();
    const brokenChat = new ChatChannel(channels, (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    const s = sender(email, brokenChat, { attempts: 1 });
    await expect(s.notify(task)).resolves.toBeUndefined();

    expect(sent).toHaveLength(1); // email still delivered
    const logs = s.logs({ taskId: task.id });
    expect(logs.map((l) => l.status).sort()).toEqual(['failed', 'sent']);

    // task row untouched
    const row = db.prepare('SELECT status FROM task WHERE id = ?').get(task.id) as { status: string };
    expect(row.status).toBe('succeeded');
  });

  it('does nothing for non-terminal statuses or when no channel is enabled', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    const { email } = fakeEmail();
    const { chat, attempts } = fakeChat();
    const s = sender(email, chat);
    await s.notify(task); // no channels
    expect(attempts()).toBe(0);
    await s.notify({ ...task, status: 'running' });
    expect(attempts()).toBe(0);
  });

  it('is wired to terminal events and never blocks the event hub', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    addChatChannel('bot');
    const { email } = fakeEmail();
    const { chat, payloads } = fakeChat(99);
    const s = sender(email, chat, { attempts: 1 });

    const queue = new TaskQueue(db, async () => ({ exitCode: 0 }), 1);
    const hub = new TaskEventHub(db, queue, reports, join(dir, 'data'));
    hub.start();
    const stop = s.start(hub);

    // emit a terminal event through the queue
    queue.emit('completed', { task });
    await vi.waitFor(() => expect(s.logs({ taskId: task.id })).toHaveLength(1));
    expect(payloads).toHaveLength(0); // failed delivery
    stop();
    queue.stop();
  });

  it('exposes the notification log through the API', async () => {
    const repoId = addRepo();
    const task = addTask(repoId, 'succeeded');
    addChatChannel('bot');
    const { email } = fakeEmail();
    const { chat } = fakeChat(99);
    const s = sender(email, chat, { attempts: 1 });
    await s.notify(task);

    const app = Fastify();
    buildNotificationRoutes(db, credentials, {
      reports,
      senderOptions: { attempts: 1, retryDelaysMs: [1] },
    }).register(app);
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notifications/logs?taskId=${task.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; channelName: string; channelType: string }[];
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('failed');
    expect(body[0].channelName).toBe('bot');
    expect(body[0].channelType).toBe('chat');
    await app.close();
  });
});
