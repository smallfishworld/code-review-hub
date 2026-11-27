import { Fragment, useId, useState } from 'react';
import { api, type Channel, type NotificationLog } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n, type MessageKey } from '../i18n';

const PLACEHOLDERS = ['{{repo}}', '{{node}}', '{{author}}', '{{status}}', '{{summary}}', '{{report_url}}'];

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

const TRIGGER_KEYS: [Trigger, MessageKey][] = [
  ['all', 'notifications.trigger.all'],
  ['failed_only', 'notifications.trigger.failed_only'],
  ['success_only', 'notifications.trigger.success_only'],
];

export function NotificationsPage() {
  const { t, formatTime } = useI18n();
  usePageTitle(t('notifications.pageTitle'));
  const channels = useApi(() => api.get<Channel[]>('/api/notifications/channels'));
  const trigger = useApi(() => api.get<{ trigger: Trigger }>('/api/notifications/trigger'));
  const logs = useApi(() => api.get<NotificationLog[]>('/api/notifications/logs?limit=50'));
  const flash = useFlash();
  const confirm = useConfirm();

  const makeEmptyChat = (): ChatForm => ({
    name: '',
    webhookUrl: '',
    headers: '',
    template: t('notifications.defaultTemplate'),
  });

  const [kind, setKind] = useState<'email' | 'chat'>('email');
  const [email, setEmail] = useState<EmailForm>(emptyEmail);
  const [chat, setChat] = useState<ChatForm>(makeEmptyChat);
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
    setChat(makeEmptyChat());
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
      setChat({
        name: c.name,
        webhookUrl: '',
        headers: Object.entries(cfg.headers ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
        template: c.template ?? t('notifications.defaultTemplate'),
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
          headers,
          template: chat.template,
        };
        if (editingId === null) await api.post('/api/notifications/channels', payload);
        else await api.put(`/api/notifications/channels/${editingId}`, payload);
      }
      flash.ok(t('notifications.toast.saved'));
      setEditingId(null);
      setEmail(emptyEmail);
      setChat(makeEmptyChat());
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
      flash.ok(c.enabled ? t('notifications.toast.disabled') : t('notifications.toast.enabled'));
      await channels.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (c: Channel) => {
    const ok = await confirm({
      title: t('notifications.confirm.deleteTitle', { name: c.name }),
      body: t('notifications.confirm.deleteBody'),
      confirmLabel: t('notifications.confirm.deleteButton'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/notifications/channels/${c.id}`);
      flash.ok(t('notifications.toast.deleted'));
      await channels.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const test = async (c: Channel) => {
    setTestResult((prev) => ({ ...prev, [c.id]: t('notifications.list.sending') }));
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
      flash.ok(t('notifications.toast.triggerUpdated'));
      await trigger.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('notifications.pageTitle')}</h1>
          <p className="page-subtitle">{t('notifications.subtitle')}</p>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => startCreate('email')}>
            {t('notifications.addEmail')}
          </button>
          <button type="button" className="secondary" onClick={() => startCreate('chat')}>
            {t('notifications.addChat')}
          </button>
        </div>
      </div>

      <section className="card trigger-rule-card" aria-labelledby="trigger-rule-title">
        <div className="trigger-rule-head">
          <h2 id="trigger-rule-title">{t('notifications.trigger.title')}</h2>
          <span className="muted small">{t('notifications.trigger.subtitle')}</span>
        </div>
        <fieldset className="radio-row">
          <legend className="visually-hidden">{t('notifications.trigger.legend')}</legend>
          {TRIGGER_KEYS.map(([value, key]) => (
            <label className="radio" key={value}>
              <input
                type="radio"
                name="trigger"
                checked={trigger.data?.trigger === value}
                onChange={() => void setTrigger(value)}
              />
              {t(key)}
            </label>
          ))}
        </fieldset>
      </section>

      <div className="split">
        <section className="card" aria-labelledby="channel-form-title">
          <h2 id="channel-form-title">
            {editingId === null ? t('notifications.form.createTitle') : t('notifications.form.editTitle')} (
            {kind === 'email' ? t('notifications.type.email') : t('notifications.type.chat')})
          </h2>
          <form className="form" onSubmit={save}>
            <label htmlFor={ids.name}>
              {t('notifications.form.name')}
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
                    {t('notifications.form.smtpHost')}
                    <input
                      id={ids.host}
                      value={email.host}
                      onChange={(e) => setEmail({ ...email, host: e.target.value })}
                      required
                    />
                  </label>
                  <label htmlFor={ids.port}>
                    {t('notifications.form.smtpPort')}
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
                  {t('notifications.form.smtpSecure')}
                </label>
                <label htmlFor={ids.from}>
                  {t('notifications.form.from')}
                  <input
                    id={ids.from}
                    value={email.from}
                    onChange={(e) => setEmail({ ...email, from: e.target.value })}
                    placeholder="review@example.com"
                    required
                  />
                </label>
                <label htmlFor={ids.to}>
                  {t('notifications.form.to')}
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
                    {t('notifications.form.smtpUser')}
                    <input
                      id={ids.username}
                      value={email.username}
                      onChange={(e) => setEmail({ ...email, username: e.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label htmlFor={ids.password}>
                    {t('notifications.form.smtpPass')}
                    <input
                      id={ids.password}
                      type="password"
                      value={email.password}
                      onChange={(e) => setEmail({ ...email, password: e.target.value })}
                      placeholder={editingId === null ? '' : t('common.leaveBlankUnchanged')}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
              </>
            ) : (
              <>
                <label htmlFor={ids.webhook}>
                  {t('notifications.form.webhook')}
                  <input
                    id={ids.webhook}
                    value={chat.webhookUrl}
                    onChange={(e) => setChat({ ...chat, webhookUrl: e.target.value })}
                    placeholder={
                      editingId === null
                        ? 'https://chat.example.com/robot/send?access_token=...'
                        : t('common.leaveBlankUnchanged')
                    }
                    required={editingId === null}
                  />
                </label>
                <label htmlFor={ids.headers}>
                  {t('notifications.form.headers')}
                  <textarea
                    id={ids.headers}
                    rows={2}
                    value={chat.headers}
                    onChange={(e) => setChat({ ...chat, headers: e.target.value })}
                    placeholder="Authorization: Bearer xxx"
                  />
                </label>
                <label htmlFor={ids.template}>
                  {t('notifications.form.template')}
                  <textarea
                    id={ids.template}
                    rows={6}
                    value={chat.template}
                    onChange={(e) => setChat({ ...chat, template: e.target.value })}
                    aria-describedby={ids.templateHint}
                  />
                </label>
                <p className="muted small" id={ids.templateHint}>
                  {t('notifications.form.templateHintPrefix', {
                    placeholders: PLACEHOLDERS.join(' '),
                  })}
                  <code>{'{"text": "..."}'}</code>
                  {t('notifications.form.templateHintMid')}
                  <code>{'{'}</code>
                  {t('notifications.form.templateHintSuffix')}
                </p>
              </>
            )}

            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {t('common.save')}
              </button>
              {editingId !== null && (
                <button type="button" className="secondary" onClick={() => startCreate(kind)}>
                  {t('common.cancelEdit')}
                </button>
              )}
            </div>
          </form>
        </section>

        <div className="grow stack">
          <section className="card" aria-labelledby="channel-list-title">
            <h2 id="channel-list-title">{t('notifications.list.title')}</h2>
            {channels.data && channels.data.length === 0 && (
              <p className="muted">{t('notifications.list.empty')}</p>
            )}
            {channels.data && channels.data.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">{t('notifications.list.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('common.name')}</th>
                      <th scope="col">{t('common.type')}</th>
                      <th scope="col">{t('notifications.list.colConfig')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col" className="actions-cell">
                        {t('common.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.data.map((c) => (
                      <Fragment key={c.id}>
                        <tr>
                          <td>{c.name}</td>
                          <td>
                            <span className={`tag ${c.type}`}>
                              {c.type === 'email'
                                ? t('notifications.type.email')
                                : t('notifications.type.chatShort')}
                            </span>
                          </td>
                          <td className="mono small ellipsis">
                            {c.type === 'email'
                              ? `${String(c.config.host ?? '')}:${String(c.config.port ?? '')}`
                              : String(c.config.webhookUrl ?? '')}
                          </td>
                          <td className="nowrap">
                            <span className={c.enabled ? 'dot ok' : 'dot off'} />
                            {c.enabled ? t('common.enabled') : t('common.disabled')}
                          </td>
                          <td className="actions-cell">
                            <div className="row-actions">
                              <button type="button" className="link" onClick={() => edit(c)}>
                                {t('common.edit')}
                                <span className="visually-hidden">
                                  {t('notifications.list.srChannel', { name: c.name })}
                                </span>
                              </button>
                              <button type="button" className="link" onClick={() => void test(c)}>
                                {t('notifications.list.sendTest')}
                                <span className="visually-hidden">
                                  {t('notifications.list.srSendTo', { name: c.name })}
                                </span>
                              </button>
                              <button type="button" className="link" onClick={() => void toggle(c)}>
                                {c.enabled ? t('common.disable') : t('common.enable')}
                                <span className="visually-hidden">
                                  {t('notifications.list.srChannel', { name: c.name })}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => void remove(c)}
                              >
                                {t('common.delete')}
                                <span className="visually-hidden">
                                  {t('notifications.list.srChannel', { name: c.name })}
                                </span>
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
              <h2 id="notify-logs-title">{t('notifications.logs.title')}</h2>
              <button type="button" className="secondary small" onClick={() => void logs.reload()}>
                {t('notifications.logs.refresh')}
              </button>
            </div>
            {logs.data && logs.data.length === 0 && (
              <p className="muted">{t('notifications.logs.empty')}</p>
            )}
            {logs.data && logs.data.length > 0 && (
              <div className="table-wrap">
                <table className="table compact">
                  <caption className="visually-hidden">{t('notifications.logs.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('notifications.logs.colTask')}</th>
                      <th scope="col">{t('notifications.logs.colChannel')}</th>
                      <th scope="col">{t('notifications.logs.colResult')}</th>
                      <th scope="col">{t('notifications.logs.colReason')}</th>
                      <th scope="col">{t('notifications.logs.colTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.data.map((log) => (
                      <tr key={log.id}>
                        <td>#{log.taskId}</td>
                        <td>
                          {log.channelName ?? log.channelId} ({log.channelType ?? '—'})
                        </td>
                        <td>
                          <span className={log.status === 'sent' ? 'tag ok' : 'tag failed'}>
                            {log.status === 'sent'
                              ? t('notifications.logs.sent')
                              : t('notifications.logs.failed')}
                          </span>
                        </td>
                        <td className="small muted">{log.detail ?? '—'}</td>
                        <td className="small">{formatTime(log.createdAt)}</td>
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
