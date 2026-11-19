import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { buildNotificationRoutes } from './notificationRoutes.js';
import { buildChatPayload, renderTemplate, DEFAULT_TEMPLATE, TemplateError } from './chatChannel.js';
import { renderEmail } from './render.js';
import type { NotificationContext } from './types.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let app: Fastify.FastifyInstance;
let credentials: CredentialService;

const context: NotificationContext = {
  repo: 'demo-repo',
  node: '1234',
  author: 'zhangsan',
  status: 'succeeded',
  summary: '发现 2 条评审意见',
  report_url: 'http://localhost:3000/tasks/1',
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crp-ch-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  app = Fastify();
  buildNotificationRoutes(db, credentials).register(app);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, payload: body as never });

describe('chat template rendering', () => {
  it('replaces all supported placeholders', () => {
    const out = renderTemplate(
      '【代码评审】{{repo}} 新节点 {{node}}（{{author}}）{{status}} {{summary}} {{report_url}}',
      context
    );
    expect(out).toBe(
      '【代码评审】demo-repo 新节点 1234（zhangsan）succeeded 发现 2 条评审意见 http://localhost:3000/tasks/1'
    );
  });

  it('leaves unknown placeholders untouched', () => {
    expect(renderTemplate('{{repo}}/{{unknown}}', context)).toBe('demo-repo/{{unknown}}');
  });

  it('wraps plain text in the default envelope', () => {
    expect(buildChatPayload('hello {{repo}}', context)).toEqual({ text: 'hello demo-repo' });
  });

  it('uses the built-in default template when none is configured', () => {
    const payload = buildChatPayload(null, context) as { text: string };
    expect(payload.text).toContain('demo-repo');
    expect(payload.text).toContain('1234');
    expect(DEFAULT_TEMPLATE).toContain('{{report_url}}');
  });

  it('parses a whole-JSON template into the request body', () => {
    const payload = buildChatPayload(
      '{"msgtype":"markdown","markdown":{"content":"{{repo}} {{node}} {{summary}}"}}',
      context
    );
    expect(payload).toEqual({
      msgtype: 'markdown',
      markdown: { content: 'demo-repo 1234 发现 2 条评审意见' },
    });
  });

  it('rejects a JSON template that renders to invalid JSON', () => {
    expect(() => buildChatPayload('{"text": "{{summary}}"}', {
      ...context,
      summary: 'bad "quote"',
    })).toThrow(TemplateError);
  });
});

describe('email rendering', () => {
  it('renders subject, text and escaped HTML', () => {
    const rendered = renderEmail({ ...context, repo: '<b>r</b>' });
    expect(rendered.subject).toBe('【代码评审】<b>r</b> 1234 成功');
    expect(rendered.text).toContain('仓库：<b>r</b>');
    expect(rendered.html).toContain('&lt;b&gt;r&lt;/b&gt;');
    expect(rendered.html).not.toContain('<b>r</b>');
  });
});

describe('test-send endpoints', () => {
  it('sends a test email through a local SMTP stub', async () => {
    const smtp = await startSmtpStub();
    try {
      const created = await post('/api/notifications/channels', {
        type: 'email',
        name: 'mail',
        host: '127.0.0.1',
        port: smtp.port,
        secure: false,
        from: 'review@example.com',
        to: ['dev@example.com'],
        username: 'u',
        password: 'p',
      });
      const id = (created.json() as { id: number }).id;
      const res = await post(`/api/notifications/channels/${id}/test`);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { ok: boolean }).ok).toBe(true);
      expect(smtp.messages.length).toBe(1);
      expect(smtp.messages[0]).toContain('Subject:');
      expect(smtp.messages[0]).toContain('dev@example.com');
    } finally {
      await smtp.close();
    }
  });

  it('returns the concrete SMTP failure reason', async () => {
    // nothing listening on this port
    const created = await post('/api/notifications/channels', {
      type: 'email',
      name: 'mail',
      host: '127.0.0.1',
      port: 1,
      secure: false,
      from: 'review@example.com',
      to: ['dev@example.com'],
    });
    const id = (created.json() as { id: number }).id;
    const res = await post(`/api/notifications/channels/${id}/test`);
    expect(res.statusCode).toBe(502);
    const body = res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain('发送失败');
  });

  it('sends a test chat message to a webhook stub', async () => {
    const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
    const server = await startHttpStub(200, '{"ok":true}', received);
    try {
      const created = await post('/api/notifications/channels', {
        type: 'chat',
        name: 'bot',
        webhookUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`,
        headers: { 'X-Token': 'abc' },
      });
      const id = (created.json() as { id: number }).id;
      const res = await post(`/api/notifications/channels/${id}/test`);
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0].headers['x-token']).toBe('abc');
      expect(JSON.parse(received[0].body)).toHaveProperty('text');
    } finally {
      server.close();
    }
  });

  it('returns the webhook failure reason', async () => {
    const server = await startHttpStub(500, 'boom', []);
    try {
      const created = await post('/api/notifications/channels', {
        type: 'chat',
        name: 'bot',
        webhookUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`,
      });
      const id = (created.json() as { id: number }).id;
      const res = await post(`/api/notifications/channels/${id}/test`);
      expect(res.statusCode).toBe(502);
      const body = res.json() as { message: string };
      expect(body.message).toContain('500');
      expect(body.message).toContain('boom');
    } finally {
      server.close();
    }
  });
});

// --- stubs -----------------------------------------------------------------

function startHttpStub(
  status: number,
  body: string,
  sink: { body: string; headers: Record<string, string | string[] | undefined> }[]
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += String(chunk)));
      req.on('end', () => {
        sink.push({ body: data, headers: req.headers });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

interface SmtpStub {
  port: number;
  messages: string[];
  close: () => Promise<void>;
}

/** Minimal SMTP server: enough for nodemailer to deliver one message. */
function startSmtpStub(): Promise<SmtpStub> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 stub ESMTP\r\n');
    socket.on('data', (chunk: string) => {
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
        if (cmd === 'EHLO') socket.write('250-stub\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'HELO') socket.write('250 stub\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
        else if (cmd === 'MAIL') socket.write('250 OK\r\n');
        else if (cmd === 'RCPT') socket.write('250 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else if (cmd === 'RSET' || cmd === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        messages,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
