import { Fragment, useId, useState } from 'react';
import { api, type McpProbeResult, type McpServer } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n } from '../i18n';

interface FormState {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  scope: 'global' | 'repo';
  repoId: string;
  allowlist: string;
  timeoutSec: number;
}

const empty: FormState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  scope: 'global',
  repoId: '',
  allowlist: '',
  timeoutSec: 10,
};

/** Outcome of a connectivity test, kept per server row. */
interface TestState {
  kind: 'pending' | 'ok' | 'fail';
  text: string;
}

export function McpServersPage() {
  const { t } = useI18n();
  usePageTitle(t('mcp.pageTitle'));
  const servers = useApi(() => api.get<McpServer[]>('/api/mcp-servers'));
  const repos = useApi(() => api.get<{ items: { id: number; name: string }[] }>('/api/repos?limit=200'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(empty);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<Record<number, TestState>>({});
  const ids = {
    name: useId(),
    transport: useId(),
    command: useId(),
    args: useId(),
    env: useId(),
    url: useId(),
    headers: useId(),
    scope: useId(),
    repoId: useId(),
    allowlist: useId(),
    timeoutSec: useId(),
  };

  const edit = (s: McpServer) => {
    setEditingId(s.id);
    const cfg = s.config as Record<string, unknown>;
    setForm({
      name: s.name,
      transport: s.transport,
      command: typeof cfg.command === 'string' ? cfg.command : '',
      args: Array.isArray(cfg.args) ? (cfg.args as string[]).join(' ') : '',
      env: cfg.env ? JSON.stringify(cfg.env, null, 0) : '',
      url: typeof cfg.url === 'string' ? cfg.url : '',
      headers: cfg.headers ? JSON.stringify(cfg.headers, null, 0) : '',
      scope: s.scope,
      repoId: s.repoId ? String(s.repoId) : '',
      allowlist: s.toolAllowlist ? s.toolAllowlist.join(', ') : '',
      timeoutSec: s.timeoutSec,
    });
  };

  const buildPayload = (): Record<string, unknown> | null => {
    let config: Record<string, unknown>;
    if (form.transport === 'stdio') {
      config = { command: form.command.trim() };
      const args = form.args.trim();
      if (args) config.args = args.split(/\s+/);
      if (form.env.trim()) {
        try {
          config.env = JSON.parse(form.env);
        } catch {
          flash.fail(t('mcp.error.envJson'));
          return null;
        }
      }
    } else {
      config = { url: form.url.trim() };
      if (form.headers.trim()) {
        try {
          config.headers = JSON.parse(form.headers);
        } catch {
          flash.fail(t('mcp.error.headersJson'));
          return null;
        }
      }
    }
    const allowlist = form.allowlist
      .split(/[,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      name: form.name.trim(),
      transport: form.transport,
      config,
      scope: form.scope,
      repoId: form.scope === 'repo' ? Number(form.repoId) : null,
      toolAllowlist: allowlist.length > 0 ? allowlist : null,
      timeoutSec: Number(form.timeoutSec) || 10,
    };
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = buildPayload();
    if (!payload) return;
    setBusy(true);
    try {
      if (editingId === null) {
        await api.post('/api/mcp-servers', payload);
        flash.ok(t('mcp.toast.saved'));
      } else {
        await api.put(`/api/mcp-servers/${editingId}`, payload);
        flash.ok(t('mcp.toast.updated'));
      }
      setForm(empty);
      setEditingId(null);
      await servers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (s: McpServer) => {
    setTestResult((prev) => ({
      ...prev,
      [s.id]: { kind: 'pending', text: t('mcp.test.pending') },
    }));
    try {
      const res = await api.post<McpProbeResult>(`/api/mcp-servers/${s.id}/test`);
      const stageText =
        res.stage === 'start'
          ? t('mcp.test.stageStart')
          : res.stage === 'timeout'
            ? t('mcp.test.stageTimeout')
            : t('mcp.test.stageProtocol');
      const text = res.ok
        ? t('mcp.test.ok', {
            tools: res.tools.length > 0 ? res.tools.join(', ') : t('mcp.test.noTools'),
          })
        : t('mcp.test.fail', { stage: stageText, error: res.error ?? '' });
      setTestResult((prev) => ({ ...prev, [s.id]: { kind: res.ok ? 'ok' : 'fail', text } }));
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [s.id]: { kind: 'fail', text: errorText(err) } }));
    }
  };

  const toggle = async (s: McpServer) => {
    try {
      await api.put(`/api/mcp-servers/${s.id}`, { enabled: !s.enabled });
      await servers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const remove = async (s: McpServer) => {
    const ok = await confirm({
      title: t('mcp.confirm.deleteTitle', { name: s.name }),
      body: t('mcp.confirm.deleteBody'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/mcp-servers/${s.id}`);
      flash.ok(t('common.deleted'));
      await servers.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('mcp.pageTitle')}</h1>
          <p className="page-subtitle">{t('mcp.subtitle')}</p>
        </div>
      </div>
      <div className="alert info" role="note">
        {t('mcp.riskNotice')}
      </div>

      <div className="split providers-split">
        <ServerForm
          form={form}
          setForm={setForm}
          ids={ids}
          editingId={editingId}
          busy={busy}
          save={save}
          cancel={() => {
            setEditingId(null);
            setForm(empty);
          }}
          repos={(repos.data as { items?: { id: number; name: string }[] } | null)?.items ?? []}
        />
        <ServerList
          servers={servers.data ?? []}
          testResult={testResult}
          onEdit={edit}
          onTest={(s) => void test(s)}
          onToggle={(s) => void toggle(s)}
          onRemove={(s) => void remove(s)}
        />
      </div>
    </div>
  );
}

interface FormIds {
  name: string;
  transport: string;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
  scope: string;
  repoId: string;
  allowlist: string;
  timeoutSec: string;
}

function ServerForm(props: {
  form: FormState;
  setForm: (f: FormState) => void;
  ids: FormIds;
  editingId: number | null;
  busy: boolean;
  save: (e: React.FormEvent) => void;
  cancel: () => void;
  repos: { id: number; name: string }[];
}) {
  const { t } = useI18n();
  const { form, setForm, ids, editingId, busy, save, cancel, repos } = props;
  return (
    <section className="card" aria-labelledby="mcp-form-title">
      <h2 id="mcp-form-title">
        {editingId === null ? t('mcp.form.createTitle') : t('mcp.form.editTitle')}
      </h2>
      <form className="form" onSubmit={save}>
        <label htmlFor={ids.name}>
          {t('common.name')}
          <input
            id={ids.name}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t('mcp.form.namePlaceholder')}
            required
          />
        </label>
        <div className="two-col">
          <label htmlFor={ids.transport}>
            {t('mcp.form.transport')}
            <select
              id={ids.transport}
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as 'stdio' | 'http' })}
            >
              <option value="stdio">{t('mcp.form.transportStdio')}</option>
              <option value="http">{t('mcp.form.transportHttp')}</option>
            </select>
          </label>
          <label htmlFor={ids.timeoutSec}>
            {t('mcp.form.timeoutSec')}
            <input
              id={ids.timeoutSec}
              type="number"
              min={1}
              max={600}
              value={form.timeoutSec}
              onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) || 10 })}
            />
          </label>
        </div>
        {form.transport === 'stdio' ? (
          <>
            <div className="two-col">
              <label htmlFor={ids.command}>
                {t('mcp.form.command')}
                <input
                  id={ids.command}
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder={t('mcp.form.commandPlaceholder')}
                  required
                />
              </label>
              <label htmlFor={ids.args}>
                {t('mcp.form.args')}
                <input
                  id={ids.args}
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder={t('mcp.form.argsPlaceholder')}
                />
              </label>
            </div>
            <label htmlFor={ids.env}>
              {t('mcp.form.env')}
              <input
                id={ids.env}
                value={form.env}
                onChange={(e) => setForm({ ...form, env: e.target.value })}
                placeholder='{"API_KEY": "..."}'
              />
            </label>
          </>
        ) : (
          <>
            <label htmlFor={ids.url}>
              URL
              <input
                id={ids.url}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
                required
              />
            </label>
            <label htmlFor={ids.headers}>
              {t('mcp.form.headers')}
              <input
                id={ids.headers}
                value={form.headers}
                onChange={(e) => setForm({ ...form, headers: e.target.value })}
                placeholder='{"Authorization": "Bearer ..."}'
              />
            </label>
          </>
        )}
        <div className="two-col">
          <label htmlFor={ids.scope}>
            {t('mcp.form.scope')}
            <select
              id={ids.scope}
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value as 'global' | 'repo' })}
            >
              <option value="global">{t('mcp.form.scopeGlobal')}</option>
              <option value="repo">{t('mcp.form.scopeRepo')}</option>
            </select>
          </label>
          {form.scope === 'repo' && (
            <label htmlFor={ids.repoId}>
              {t('mcp.form.repoId')}
              <select
                id={ids.repoId}
                value={form.repoId}
                onChange={(e) => setForm({ ...form, repoId: e.target.value })}
                required
              >
                <option value="">{t('mcp.form.selectRepo')}</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label htmlFor={ids.allowlist}>
          {t('mcp.form.allowlist')}
          <input
            id={ids.allowlist}
            value={form.allowlist}
            onChange={(e) => setForm({ ...form, allowlist: e.target.value })}
            placeholder={t('mcp.form.allowlistPlaceholder')}
          />
        </label>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {t('common.save')}
          </button>
          {editingId !== null && (
            <button type="button" className="secondary" onClick={cancel}>
              {t('common.cancelEdit')}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function ServerList(props: {
  servers: McpServer[];
  testResult: Record<number, TestState>;
  onEdit: (s: McpServer) => void;
  onTest: (s: McpServer) => void;
  onToggle: (s: McpServer) => void;
  onRemove: (s: McpServer) => void;
}) {
  const { t } = useI18n();
  const { servers, testResult, onEdit, onTest, onToggle, onRemove } = props;
  return (
    <section className="card grow" aria-labelledby="mcp-list-title">
      <h2 id="mcp-list-title">{t('mcp.list.title')}</h2>
      {servers.length === 0 && <p className="muted">{t('mcp.list.empty')}</p>}
      {servers.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">{t('mcp.list.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('common.name')}</th>
                <th scope="col">{t('common.type')}</th>
                <th scope="col">{t('mcp.list.colTarget')}</th>
                <th scope="col">{t('mcp.list.colScope')}</th>
                <th scope="col">{t('common.status')}</th>
                <th scope="col" className="actions-cell">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const result = testResult[s.id];
                const cfg = s.config as Record<string, unknown>;
                const target =
                  s.transport === 'stdio'
                    ? String(cfg.command ?? '')
                    : String(cfg.url ?? '');
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td>{s.name}</td>
                      <td className="small">{s.transport}</td>
                      <td className="mono ellipsis" title={target}>
                        {target}
                      </td>
                      <td className="small">
                        {s.scope === 'global'
                          ? t('mcp.list.scopeGlobal')
                          : t('mcp.list.scopeRepo', { id: s.repoId ?? '' })}
                      </td>
                      <td>
                        <span className={`tag ${s.enabled ? 'ok' : 'muted'}`}>
                          {s.enabled ? t('common.enabled') : t('common.disabled')}
                        </span>
                      </td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          <button type="button" className="link" onClick={() => onEdit(s)}>
                            {t('common.edit')}
                            <span className="visually-hidden">MCP {s.name}</span>
                          </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => onTest(s)}
                            disabled={result?.kind === 'pending'}
                          >
                            {result?.kind === 'pending' ? t('mcp.test.pending') : t('mcp.list.test')}
                            <span className="visually-hidden">MCP {s.name}</span>
                          </button>
                          <button type="button" className="link" onClick={() => onToggle(s)}>
                            {s.enabled ? t('common.disable') : t('common.enable')}
                            <span className="visually-hidden">MCP {s.name}</span>
                          </button>
                          <button type="button" className="link danger" onClick={() => onRemove(s)}>
                            {t('common.delete')}
                            <span className="visually-hidden">MCP {s.name}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {result && (
                      <tr className="test-row">
                        <td colSpan={6}>
                          <p className={`test-result ${result.kind}`} role="status" aria-live="polite">
                            {result.text}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
