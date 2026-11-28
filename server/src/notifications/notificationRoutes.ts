import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { ChannelError, ChannelService, type ChannelInput } from './channelService.js';
import { EmailChannel, type TransportFactory } from './emailChannel.js';
import { ChatChannel, sampleContext } from './chatChannel.js';
import { NotificationSender, type SenderOptions } from './notificationSender.js';
import type { ReportService } from '../tasks/reportService.js';

/**
 * Notification channel configuration API (task 6.1) plus test-send
 * endpoints (tasks 6.2 / 6.3) and the notification log (task 6.4).
 *
 * GET    /api/notifications/channels
 * GET    /api/notifications/channels/:id
 * POST   /api/notifications/channels
 * PUT    /api/notifications/channels/:id
 * DELETE /api/notifications/channels/:id
 * POST   /api/notifications/channels/:id/enable
 * POST   /api/notifications/channels/:id/disable
 * POST   /api/notifications/channels/:id/test    send a test message
 * GET    /api/notifications/trigger
 * PUT    /api/notifications/trigger   { trigger: all|failed_only|success_only }
 * GET    /api/notifications/logs      ?taskId=&limit=
 */
export interface NotificationRouteOptions {
  /** Injected for tests; defaults to real nodemailer SMTP. */
  transportFactory?: TransportFactory;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Required to expose the notification log / build the sender. */
  reports?: ReportService;
  senderOptions?: SenderOptions;
}

export function buildNotificationRoutes(
  db: Database.Database,
  credentials: CredentialService,
  options: NotificationRouteOptions = {}
): {
  register: (app: FastifyInstance) => void;
  service: ChannelService;
  email: EmailChannel;
  chat: ChatChannel;
  sender: NotificationSender | null;
} {
  const service = new ChannelService(db, credentials);
  const email = new EmailChannel(service, options.transportFactory);
  const chat = new ChatChannel(service, options.fetchImpl);
  const sender = options.reports
    ? new NotificationSender(db, service, email, chat, options.reports, options.senderOptions)
    : null;

  const register = (app: FastifyInstance) => {
    const handle = (err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      if (err instanceof ChannelError) return reply.code(err.statusCode).send({ message: err.message });
      throw err;
    };

    app.get('/api/notifications/channels', async () => service.list());

    app.get('/api/notifications/channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return service.get(Number(id));
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.post('/api/notifications/channels', async (req, reply) => {
      try {
        const created = service.create((req.body ?? {}) as ChannelInput);
        return reply.code(201).send(created);
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.put('/api/notifications/channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return service.update(Number(id), (req.body ?? {}) as ChannelInput);
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.delete('/api/notifications/channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        service.delete(Number(id));
        return reply.code(204).send();
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.post('/api/notifications/channels/:id/enable', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return service.setEnabled(Number(id), true);
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.post('/api/notifications/channels/:id/disable', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        return service.setEnabled(Number(id), false);
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.post('/api/notifications/channels/:id/test', async (req, reply) => {
      const { id } = req.params as { id: string };
      const channelId = Number(id);
      let channel;
      try {
        channel = service.get(channelId);
      } catch (err) {
        return handle(err, reply);
      }
      try {
        // Test context defaults to the canned sample; callers may override
        // any field (e.g. the author, so the test message reaches a real
        // recipient on template-routed channels).
        const body = (req.body ?? {}) as { context?: Record<string, string> };
        const context = { ...sampleContext(), ...(body.context ?? {}) };
        if (channel.type === 'email') {
          await email.sendRaw(channelId, {
            subject: '【代码评审平台】测试邮件',
            text: '这是一封测试邮件，收到即表示邮件通知渠道配置正确。',
          });
        } else {
          await chat.send(channelId, context);
        }
        return { ok: true, message: '发送成功' };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ ok: false, message: `发送失败：${reason}` });
      }
    });

    app.get('/api/notifications/logs', async (req) => {
      const query = req.query as { taskId?: string; limit?: string };
      if (!sender) return [];
      return sender.logs({
        taskId: query.taskId ? Number(query.taskId) : undefined,
        limit: query.limit ? Number(query.limit) : undefined,
      });
    });
    app.get('/api/notifications/trigger', async () => ({ trigger: service.getTrigger() }));

    app.put('/api/notifications/trigger', async (req, reply) => {
      const body = (req.body ?? {}) as { trigger?: string };
      try {
        return { trigger: service.setTrigger(String(body.trigger ?? '')) };
      } catch (err) {
        return handle(err, reply);
      }
    });

    app.get('/api/notifications/failure-policy', async () => service.getFailurePolicy());

    app.put('/api/notifications/failure-policy', async (req, reply) => {
      const body = (req.body ?? {}) as {
        autoRetries?: number;
        notifyAdminsOnFailure?: boolean;
        adminRecipients?: string[];
      };
      try {
        return service.setFailurePolicy(body);
      } catch (err) {
        return handle(err, reply);
      }
    });
  };

  return { register, service, email, chat, sender };
}
