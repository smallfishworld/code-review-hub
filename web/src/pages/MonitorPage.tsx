import { useEffect, useId, useState } from 'react';
import { api, type MonitorRule, type Repo } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { usePermission } from '../auth/AuthContext';
import { useFlash } from '../components/Toast';
import { useI18n, type MessageKey } from '../i18n';

interface RuleForm {
  intervalSeconds: number;
  authorWhitelist: string;
  pathPrefixes: string;
  backtrackNodes: number;
}

const defaults: RuleForm = {
  intervalSeconds: 300,
  authorWhitelist: '',
  pathPrefixes: '',
  backtrackNodes: 0,
};

const INIT_LABEL_KEYS: Record<string, MessageKey> = {
  ready: 'monitor.status.initReady',
  cloning: 'monitor.status.initCloning',
  failed: 'monitor.status.initFailed',
};

export function MonitorPage() {
  const { t, formatTime } = useI18n();
  usePageTitle(t('monitor.pageTitle'));
  const canEdit = usePermission('monitor:edit');
  const repos = useApi(() => api.get<Repo[]>('/api/repos'));
  const rules = useApi(() => api.get<MonitorRule[]>('/api/monitor/rules'));
  const flash = useFlash();
  const [selectedRepo, setSelectedRepo] = useState<number | null>(null);
  const [form, setForm] = useState<RuleForm>(defaults);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = {
    repo: useId(),
    interval: useId(),
    authors: useId(),
    paths: useId(),
    backtrack: useId(),
    hint: useId(),
  };

  const currentRule = rules.data?.find((r) => r.repoId === selectedRepo) ?? null;

  useEffect(() => {
    if (selectedRepo === null && repos.data && repos.data.length > 0) {
      setSelectedRepo(repos.data[0].id);
    }
  }, [repos.data, selectedRepo]);

  useEffect(() => {
    if (currentRule) {
      setForm({
        intervalSeconds: currentRule.intervalSeconds,
        authorWhitelist: currentRule.authorWhitelist.join('\n'),
        pathPrefixes: currentRule.pathPrefixes.join('\n'),
        backtrackNodes: currentRule.backtrackNodes,
      });
    } else {
      setForm(defaults);
    }
    setFormError(null);
  }, [currentRule?.id, selectedRepo]);

  const parseLines = (text: string) =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRepo === null) return;
    setFormError(null);
    if (!Number.isInteger(form.intervalSeconds) || form.intervalSeconds < 30) {
      setFormError(t('monitor.error.interval'));
      return;
    }
    if (!Number.isInteger(form.backtrackNodes) || form.backtrackNodes < 0) {
      setFormError(t('monitor.error.backtrack'));
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/monitor/rules/${selectedRepo}`, {
        intervalSeconds: form.intervalSeconds,
        authorWhitelist: parseLines(form.authorWhitelist),
        pathPrefixes: parseLines(form.pathPrefixes),
        backtrackNodes: form.backtrackNodes,
      });
      flash.ok(t('monitor.toast.saved'));
      await rules.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const action = async (path: string, okText: string) => {
    if (selectedRepo === null) return;
    setBusy(true);
    try {
      await api.post(`/api/monitor/rules/${selectedRepo}/${path}`);
      flash.ok(okText);
      await rules.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const status = currentRule?.status ?? null;
  const repo = repos.data?.find((r) => r.id === selectedRepo) ?? null;

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('monitor.pageTitle')}</h1>
          <p className="page-subtitle">{t('monitor.subtitle')}</p>
        </div>
        <button type="button" className="secondary" onClick={() => void rules.reload()}>
          {t('monitor.refreshStatus')}
        </button>
      </div>

      {repos.data && repos.data.length === 0 && (
        <div className="alert info">{t('monitor.noRepos')}</div>
      )}

      {repos.data && repos.data.length > 0 && (
        <div className="split">
          <section className="card" aria-labelledby="rule-form-title">
            <h2 id="rule-form-title">{t('monitor.form.title')}</h2>
            <form className="form" onSubmit={save} noValidate aria-describedby={ids.hint}>
              <label htmlFor={ids.repo}>
                {t('monitor.form.repo')}
                <select
                  id={ids.repo}
                  value={selectedRepo ?? ''}
                  onChange={(e) => setSelectedRepo(Number(e.target.value))}
                >
                  {repos.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.type.toUpperCase()})
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="form-fieldset" disabled={!canEdit}>
                <div className="two-col">
                  <label htmlFor={ids.interval}>
                    {t('monitor.form.interval')}
                    <input
                      id={ids.interval}
                      type="number"
                      min={30}
                      value={form.intervalSeconds}
                      onChange={(e) =>
                        setForm({ ...form, intervalSeconds: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label htmlFor={ids.backtrack}>
                    {t('monitor.form.backtrack')}
                    <input
                      id={ids.backtrack}
                      type="number"
                      min={0}
                      value={form.backtrackNodes}
                      onChange={(e) => setForm({ ...form, backtrackNodes: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <p className="muted small form-hint">{t('monitor.form.backtrackHint')}</p>
                <label htmlFor={ids.authors}>
                  {t('monitor.form.authors')}
                  <textarea
                    id={ids.authors}
                    rows={3}
                    value={form.authorWhitelist}
                    onChange={(e) => setForm({ ...form, authorWhitelist: e.target.value })}
                    placeholder={'alice\nbob'}
                  />
                </label>
                <label htmlFor={ids.paths}>
                  {t('monitor.form.paths')}
                  <textarea
                    id={ids.paths}
                    rows={3}
                    value={form.pathPrefixes}
                    onChange={(e) => setForm({ ...form, pathPrefixes: e.target.value })}
                    placeholder={'trunk/src/\nsrc/main/'}
                  />
                </label>
              </fieldset>
              {repo?.type === 'git' && (
                <p className="muted small">
                  {t('monitor.form.gitBranchNote', { branch: repo.branch ?? 'main' })}
                </p>
              )}
              {formError && (
                <div className="alert error" role="alert">
                  {formError}
                </div>
              )}
              {canEdit ? (
                <div className="actions">
                  <button className="primary" type="submit" disabled={busy}>
                    {t('monitor.form.save')}
                  </button>
                  {currentRule && (
                    <button
                      type="button"
                      className={currentRule.enabled ? 'secondary' : 'primary'}
                      disabled={busy}
                      onClick={() =>
                        currentRule.enabled
                          ? action('disable', t('monitor.toast.disabled'))
                          : action('enable', t('monitor.toast.enabled'))
                      }
                    >
                      {currentRule.enabled ? t('monitor.form.disable') : t('monitor.form.enable')}
                    </button>
                  )}
                  {currentRule && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => action('poll', t('monitor.toast.polled'))}
                    >
                      {t('monitor.form.pollNow')}
                    </button>
                  )}
                </div>
              ) : (
                <p className="small muted">当前角色仅可查看监控规则与运行状态。</p>
              )}
              <p className="muted small" id={ids.hint}>
                {t('monitor.form.hint')}
              </p>
            </form>
          </section>

          <section className="card grow" aria-labelledby="monitor-status-title">
            <h2 id="monitor-status-title">{t('monitor.status.title')}</h2>
            {!currentRule && <p className="muted">{t('monitor.status.unconfigured')}</p>}
            {currentRule && status && (
              <>
                <div className="stat-grid cols-3">
                  <div className="stat">
                    <span className="stat-label">{t('common.status')}</span>
                    <span className={currentRule.enabled ? 'stat-value ok' : 'stat-value off'}>
                      {currentRule.enabled
                        ? t('monitor.status.running')
                        : t('monitor.status.stopped')}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{t('monitor.status.interval')}</span>
                    <span className="stat-value">{currentRule.intervalSeconds}s</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{t('monitor.status.headNode')}</span>
                    <span className="stat-value mono">{status.headNode ?? '—'}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{t('monitor.status.lastNode')}</span>
                    <span className="stat-value mono">{status.lastNode ?? '—'}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{t('monitor.status.lastPoll')}</span>
                    <span className="stat-value">{formatTime(status.lastPollAt)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{t('monitor.status.init')}</span>
                    <span className="stat-value">
                      {INIT_LABEL_KEYS[status.initStatus]
                        ? t(INIT_LABEL_KEYS[status.initStatus])
                        : status.initStatus}
                    </span>
                  </div>
                </div>
                {status.initStatus === 'cloning' && (
                  <div className="alert info">{t('monitor.status.cloningAlert')}</div>
                )}
                {status.initStatus === 'failed' && (
                  <div className="alert error" role="alert">
                    {t('monitor.status.failedAlert')}
                  </div>
                )}
                {status.lastPollError && (
                  <div className="alert error" role="alert">
                    {t('monitor.status.lastPollError', { error: status.lastPollError })}
                  </div>
                )}
                <h3>{t('monitor.log.title')}</h3>
                {status.recentLog.length === 0 && <p className="muted">{t('monitor.log.empty')}</p>}
                {status.recentLog.length > 0 && (
                  <div className="table-wrap">
                    <table className="table compact">
                      <caption className="visually-hidden">{t('monitor.log.caption')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('monitor.log.colNode')}</th>
                          <th scope="col">{t('monitor.log.colAction')}</th>
                          <th scope="col">{t('monitor.log.colAuthor')}</th>
                          <th scope="col">{t('monitor.log.colReason')}</th>
                          <th scope="col">{t('monitor.log.colTime')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {status.recentLog.map((log) => (
                          <tr key={log.id}>
                            <td className="mono">{log.node}</td>
                            <td>
                              <span className={log.action === 'triggered' ? 'tag ok' : 'tag off'}>
                                {log.action === 'triggered'
                                  ? t('monitor.log.triggered')
                                  : t('monitor.log.skipped')}
                              </span>
                            </td>
                            <td>{log.author ?? '—'}</td>
                            <td className="muted small">{log.reason ?? '—'}</td>
                            <td className="small">{formatTime(log.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
