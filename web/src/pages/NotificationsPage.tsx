import { Fragment, useId, useState } from 'react';
import { api, type Channel, type NotificationLog } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';

const PLACEHOLDERS = ['{{repo}}', '{{node}}', '{{author}}', '{{status}}', '{{summary}}', '{{report_url}}'];

const DEFAULT_TEMPLATE = `【代码评审】{{repo}} {{node}} {{status}}
上库人员：{{author}}
摘要：{{summary}}
报告：{{report_url}}`;

type Trigger = 'all' | 'failed_only' | 'success_only';

interface EmailForm {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  from: string;
  to: string;
  username: string;
  password: string;
}

interface ChatForm {
  name: string;
  webhookUrl: string;
  headers: string;
  template: string;
}

const emptyEmail: EmailForm = {
  name: '',
  host: '',
  port: 587,
  secure: false,
  from: '',
  to: '',
  username: '',
  password: '',
};

const emptyChat: ChatForm = {
  name: '',
  webhookUrl: '',
  headers: '',
  template: DEFAULT_TEMPLATE,
};

export function NotificationsPage() {
  usePageTitle('通知配置');
  const channels = useApi(() => api.get<Channel[]>('/api/notifications/channels'));
  const trigger = useApi(() => api.get<{ trigger: Trigger }>('/api/notifications/trigger'));
  const logs = useApi(() => api.get<NotificationLog[]>('/api/notifications/logs?limit=50'));
  const flash = useFlash();
  const confirm = useConfirm();

  const [kind, setKind] = useState<'email' | 'chat'>('email');
  const [email, setEmail] = useState<EmailForm>(emptyEmail);
  const [chat, setChat] = useState<ChatForm>(emptyChat);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<number, string>>({});
  const ids = {
    name: useId(),
    host: useId(),
    port: useId(),
    secure: useId(),
    from: useId(),
    to: useId(),
    username: useId(),
    password: useId(),
    webhook: useId(),
    headers: useId(),
    template: useId(),
    templateHint: useId(),
  };

  const startCreate = (type: 'email' | 'chat') => {
    setKind(type);
    setEditingId(null);
    setEmail(emptyEmail);
    setChat(emptyChat);
  };

  const edit = (c: Channel) => {
    setKind(c.type);
    setEditingId(c.id);
    if (c.type === 'email') {
      const cfg = c.config as {
        host?: string;
        port?: number;
        secure?: boolean;
        from?: string;
        to?: string[];
        username?: string;
      };
      setEmail({
        name: c.name,
        host: cfg.host ?? '',
        port: cfg.port ?? 587,
        secure: cfg.secure === true,
        from: cfg.from ?? '',
        to: (cfg.to ?? []).join('\n'),
        username: cfg.username ?? '',
        password: '',
      });
    } else {
      const cfg = c.config as { headers?: Record<string, string> };
      // Values arrive masked (`********`); the server treats an echoed mask as
      // "keep the stored value", so editing a channel no longer wipes headers.
      setChat({
        name: c.name,
        webhookUrl: '',
        headers: Object.entries(cfg.headers ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
        template: c.template ?? DEFAULT_TEMPLATE,
      });
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === 'email') {
        const payload = {
          type: 'email',
          name: email.name.trim(),
          host: email.host.trim(),
          port: Number(email.port),
          secure: email.secure,
          from: email.from.trim(),
          to: email.to
            .split(/[\n,;]/)
            .map((s) => s.trim())
            .filter(Boolean),
          username: email.username.trim() || undefined,
          password: email.password || undefined,
        };
        if (editingId === null) await api.post('/api/notifications/channels', payload);
        else await api.put(`/api/notifications/channels/${editingId}`, payload);
      } else {
        const headers: Record<string, string> = {};
        for (const line of chat.headers.split('\n')) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          const key = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          if (key && value) headers[key] = value;
        }
        const payload = {
          type: 'chat',
          name: chat.name.trim(),
          webhookUrl: chat.webhookUrl.trim() || undefined,
          // Always send the object (even empty): `undefined` means "leave the
          // stored headers alone", so deleting every line would never clear them.
          headers,
          template: chat.template,
        };
        if (editingId === null) await api.post('/api/notifications/channels', payload);
        else await api.put(`/api/notifications/channels/${editingId}`, payload);
      }
      flash.ok('通知渠道已保存');
      setEditingId(null);
      setEmail(emptyEmail);
      setChat(emptyChat);
      await channels.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (c: Channel) => {
    try {
      await api.post(
        `/api/notifications/channels/${c.id}/${c.enabled ? 'disable' : 'enable'}`
      );
      flash.ok(c.enabled ? '渠道已停用' : '渠道已启用');
      await channels.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (c: Channel) => {
    const ok = await confirm({
      title: `删除通知渠道「${c.name}」？`,
      body: '删除后该渠道不再接收评审通知，历史通知日志会保留。',
      confirmLabel: '删除渠道',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/notifications/channels/${c.id}`);
      flash.ok('渠道已删除');
      await channels.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const test = async (c: Channel) => {
    setTestResult((prev) => ({ ...prev, [c.id]: '发送中…' }));
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/api/notifications/channels/${c.id}/test`
      );
      setTestResult((prev) => ({ ...prev, [c.id]: res.message }));
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [c.id]: errorText(err) }));
    }
  };

  const setTrigger = async (value: Trigger) => {
    try {
      await api.put('/api/notifications/trigger', { trigger: value });
      flash.ok('触发规则已更新');
      await trigger.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>通知配置</h1>
          <p className="page-subtitle">配置邮件与群机器人 Webhook 通知渠道及评审完成推送规则</p>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => startCreate('email')}>
            新增邮件渠道
          </button>
          <button type="button" className="secondary" onClick={() => startCreate('chat')}>
            新增机器人渠道
          </button>
        </div>
      </div>

      <section className="card trigger-rule-card" aria-labelledby="trigger-rule-title">
        <div className="trigger-rule-head">
          <h2 id="trigger-rule-title">触发规则</h2>
          <span className="muted small">决定评审任务在何种结束状态下推送通知</span>
        </div>
        <fieldset className="radio-row">
          <legend className="visually-hidden">通知触发规则</legend>
          {(
            [
              ['all', '全部完成（成功与失败都通知）'],
              ['failed_only', '仅失败'],
              ['success_only', '仅成功'],
            ] as [Trigger, string][]
          ).map(([value, label]) => (
            <label className="radio" key={value}>
              <input
                type="radio"
                name="trigger"
                checked={trigger.data?.trigger === value}
                onChange={() => void setTrigger(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      </section>

      <div className="split">
        <section className="card" aria-labelledby="channel-form-title">
          <h2 id="channel-form-title">
            {editingId === null ? '新增渠道' : '编辑渠道'}（{kind === 'email' ? '邮件' : '聊天机器人'}）
          </h2>
          <form className="form" onSubmit={save}>
            <label htmlFor={ids.name}>
              渠道名称
              <input
                id={ids.name}
                value={kind === 'email' ? email.name : chat.name}
                onChange={(e) =>
                  kind === 'email'
                    ? setEmail({ ...email, name: e.target.value })
                    : setChat({ ...chat, name: e.target.value })
                }
                required
              />
            </label>

            {kind === 'email' ? (
              <>
                <div className="two-col">
                  <label htmlFor={ids.host}>
                    SMTP 服务器
                    <input
                      id={ids.host}
                      value={email.host}
                      onChange={(e) => setEmail({ ...email, host: e.target.value })}
                      required
                    />
                  </label>
                  <label htmlFor={ids.port}>
                    端口
                    <input
                      id={ids.port}
                      type="number"
                      value={email.port}
                      onChange={(e) => setEmail({ ...email, port: Number(e.target.value) })}
                      required
                    />
                  </label>
                </div>
                <label className="checkbox" htmlFor={ids.secure}>
                  <input
                    id={ids.secure}
                    type="checkbox"
                    checked={email.secure}
                    onChange={(e) => setEmail({ ...email, secure: e.target.checked })}
                  />
                  使用 SSL/TLS（465 端口通常勾选）
                </label>
                <label htmlFor={ids.from}>
                  发件人
                  <input
                    id={ids.from}
                    value={email.from}
                    onChange={(e) => setEmail({ ...email, from: e.target.value })}
                    placeholder="review@example.com"
                    required
                  />
                </label>
                <label htmlFor={ids.to}>
                  收件人（每行一个或用逗号分隔）
                  <textarea
                    id={ids.to}
                    rows={3}
                    value={email.to}
                    onChange={(e) => setEmail({ ...email, to: e.target.value })}
                    required
                  />
                </label>
                <div className="two-col">
                  <label htmlFor={ids.username}>
                    SMTP 用户名
                    <input
                      id={ids.username}
                      value={email.username}
                      onChange={(e) => setEmail({ ...email, username: e.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label htmlFor={ids.password}>
                    SMTP 密码
                    <input
                      id={ids.password}
                      type="password"
                      value={email.password}
                      onChange={(e) => setEmail({ ...email, password: e.target.value })}
                      placeholder={editingId === null ? '' : '留空表示不修改'}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
              </>
            ) : (
              <>
                <label htmlFor={ids.webhook}>
                  Webhook 地址
                  <input
                    id={ids.webhook}
                    value={chat.webhookUrl}
                    onChange={(e) => setChat({ ...chat, webhookUrl: e.target.value })}
                    placeholder={
                      editingId === null ? 'https://chat.example.com/robot/send?access_token=...' : '留空表示不修改'
                    }
                    required={editingId === null}
                  />
                </label>
                <label htmlFor={ids.headers}>
                  自定义 Header（每行 `名称: 值`，可选）
                  <textarea
                    id={ids.headers}
                    rows={2}
                    value={chat.headers}
                    onChange={(e) => setChat({ ...chat, headers: e.target.value })}
                    placeholder="Authorization: Bearer xxx"
                  />
                </label>
                <label htmlFor={ids.template}>
                  消息模板
                  <textarea
                    id={ids.template}
                    rows={6}
                    value={chat.template}
                    onChange={(e) => setChat({ ...chat, template: e.target.value })}
                    aria-describedby={ids.templateHint}
                  />
                </label>
                <p className="muted small" id={ids.templateHint}>
                  可用占位符：{PLACEHOLDERS.join(' ')}。纯文本模板会包装为{' '}
                  <code>{'{"text": "..."}'}</code>；以 <code>{'{'}</code> 开头的模板按整包 JSON 处理（渲染后校验）。
                </p>
              </>
            )}

            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                保存
              </button>
              {editingId !== null && (
                <button type="button" className="secondary" onClick={() => startCreate(kind)}>
                  取消编辑
                </button>
              )}
            </div>
          </form>
        </section>

        <div className="grow stack">
          <section className="card" aria-labelledby="channel-list-title">
            <h2 id="channel-list-title">渠道列表</h2>
            {channels.data && channels.data.length === 0 && <p className="muted">暂无通知渠道。</p>}
            {channels.data && channels.data.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">通知渠道列表</caption>
                  <thead>
                    <tr>
                      <th scope="col">名称</th>
                      <th scope="col">类型</th>
                      <th scope="col">配置</th>
                      <th scope="col">状态</th>
                      <th scope="col" className="actions-cell">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.data.map((c) => (
                      <Fragment key={c.id}>
                        <tr>
                          <td>{c.name}</td>
                          <td>
                            <span className={`tag ${c.type}`}>{c.type === 'email' ? '邮件' : '机器人'}</span>
                          </td>
                          <td className="mono small ellipsis">
                            {c.type === 'email'
                              ? `${String(c.config.host ?? '')}:${String(c.config.port ?? '')}`
                              : String(c.config.webhookUrl ?? '')}
                          </td>
                          <td className="nowrap">
                            <span className={c.enabled ? 'dot ok' : 'dot off'} />
                            {c.enabled ? '启用' : '停用'}
                          </td>
                          <td className="actions-cell">
                            <div className="row-actions">
                              <button type="button" className="link" onClick={() => edit(c)}>
                                编辑<span className="visually-hidden">渠道 {c.name}</span>
                              </button>
                              <button type="button" className="link" onClick={() => void test(c)}>
                                发送测试<span className="visually-hidden">到渠道 {c.name}</span>
                              </button>
                              <button type="button" className="link" onClick={() => void toggle(c)}>
                                {c.enabled ? '停用' : '启用'}
                                <span className="visually-hidden">渠道 {c.name}</span>
                              </button>
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => void remove(c)}
                              >
                                删除<span className="visually-hidden">渠道 {c.name}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {testResult[c.id] && (
                          <tr className="test-row">
                            <td colSpan={5}>
                              <p className="test-result" role="status">
                                {testResult[c.id]}
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="notify-logs-title">
            <div className="card-head">
              <h2 id="notify-logs-title">通知日志</h2>
              <button type="button" className="secondary small" onClick={() => void logs.reload()}>
                刷新日志
              </button>
            </div>
            {logs.data && logs.data.length === 0 && <p className="muted">暂无通知记录。</p>}
            {logs.data && logs.data.length > 0 && (
              <div className="table-wrap">
                <table className="table compact">
                  <caption className="visually-hidden">最近的通知发送记录</caption>
                  <thead>
                    <tr>
                      <th scope="col">任务</th>
                      <th scope="col">渠道</th>
                      <th scope="col">结果</th>
                      <th scope="col">原因</th>
                      <th scope="col">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.data.map((log) => (
                      <tr key={log.id}>
                        <td>#{log.taskId}</td>
                        <td>
                          {log.channelName ?? log.channelId}（{log.channelType ?? '—'}）
                        </td>
                        <td>
                          <span className={log.status === 'sent' ? 'tag ok' : 'tag failed'}>
                            {log.status === 'sent' ? '已发送' : '失败'}
                          </span>
                        </td>
                        <td className="small muted">{log.detail ?? '—'}</td>
                        <td className="small">{new Date(log.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
