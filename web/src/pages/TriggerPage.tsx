import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Repo, type Task, type TaskList } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { NodePicker } from '../components/NodePicker';
import { useFlash } from '../components/Toast';
import { useI18n, type MessageKey } from '../i18n';

const STATUS_KEYS: Record<string, MessageKey> = {
  queued: 'tasks.status.queued',
  running: 'tasks.status.running',
  succeeded: 'tasks.status.succeeded',
  failed: 'tasks.status.failed',
  cancelled: 'tasks.status.cancelled',
};

export function TriggerPage() {
  const { t, formatTime } = useI18n();
  usePageTitle(t('trigger.pageTitle'));
  const repos = useApi(() => api.get<Repo[]>('/api/repos'));
  const recentTasks = useApi(() => api.get<TaskList>('/api/tasks?trigger=manual&limit=10'));
  const flash = useFlash();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [repoId, setRepoId] = useState<number | ''>('');
  const [mode, setMode] = useState<'single' | 'range'>('single');
  const [node, setNode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Task[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const ids = {
    repo: useId(),
    single: useId(),
    range: useId(),
    node: useId(),
    from: useId(),
    to: useId(),
    hint: useId(),
  };

  const repo = repos.data?.find((r) => r.id === repoId) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (repoId === '') return;
    setBusy(true);
    setResult(null);
    setWarning(null);
    try {
      if (mode === 'single') {
        try {
          const res = await api.post<{ task: Task }>(`/api/repos/${repoId}/review`, {
            node: node.trim(),
          });
          setResult([res.task]);
          flash.ok(t('trigger.toast.created', { id: res.task.id }));
          void recentTasks.reload();
        } catch (err) {
          const e2 = err as { status?: number; body?: { duplicate?: boolean } };
          if (e2.status === 409 && e2.body?.duplicate) {
            const ok = await confirm({
              title: t('trigger.confirm.duplicateTitle'),
              body: t('trigger.confirm.duplicateBody', { node: node.trim() }),
              confirmLabel: t('trigger.confirm.duplicateButton'),
            });
            if (!ok) return;
            const res = await api.post<{ task: Task }>(`/api/repos/${repoId}/review`, {
              node: node.trim(),
              force: true,
            });
            setResult([res.task]);
            flash.ok(t('trigger.toast.recreated', { id: res.task.id }));
            void recentTasks.reload();
          } else {
            throw err;
          }
        }
      } else {
        const res = await api.post<{ tasks: Task[]; duplicates: number; warning?: string }>(
          `/api/repos/${repoId}/review-range`,
          { from: from.trim(), to: to.trim() }
        );
        setResult(res.tasks);
        setWarning(res.warning ?? null);
        if (res.tasks.length === 0) {
          flash.fail(
            res.duplicates > 0
              ? t('trigger.toast.allDuplicates', { count: res.duplicates })
              : t('trigger.toast.noNodes')
          );
        } else if (res.duplicates > 0) {
          flash.ok(
            t('trigger.toast.createdRangeWithDup', {
              created: res.tasks.length,
              duplicates: res.duplicates,
            })
          );
          void recentTasks.reload();
        } else {
          flash.ok(t('trigger.toast.createdRange', { created: res.tasks.length }));
          void recentTasks.reload();
        }
      }
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const placeholder =
    repo?.type === 'git' ? t('trigger.form.gitPlaceholder') : t('trigger.form.svnPlaceholder');

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('trigger.heading')}</h1>
          <p className="page-subtitle">{t('trigger.subtitle')}</p>
        </div>
        <Link to="/tasks" className="btn-link secondary">
          {t('trigger.allTasks')}
        </Link>
      </div>

      <div className="split">
        <section className="card" aria-labelledby="trigger-form-title">
          <h2 id="trigger-form-title">{t('trigger.form.title')}</h2>
          <form className="form" onSubmit={submit} aria-describedby={ids.hint}>
            <label htmlFor={ids.repo}>
              {t('trigger.form.repo')}
              <select
                id={ids.repo}
                value={repoId}
                onChange={(e) => setRepoId(e.target.value === '' ? '' : Number(e.target.value))}
                required
              >
                <option value="">{t('trigger.form.selectRepo')}</option>
                {repos.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.type.toUpperCase()})
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="radio-row">
              <legend className="visually-hidden">{t('trigger.form.scopeLegend')}</legend>
              <label className="radio" htmlFor={ids.single}>
                <input
                  id={ids.single}
                  type="radio"
                  name="trigger-mode"
                  checked={mode === 'single'}
                  onChange={() => setMode('single')}
                />
                {t('trigger.form.single')}
              </label>
              <label className="radio" htmlFor={ids.range}>
                <input
                  id={ids.range}
                  type="radio"
                  name="trigger-mode"
                  checked={mode === 'range'}
                  onChange={() => setMode('range')}
                />
                {t('trigger.form.range')}
              </label>
            </fieldset>

            {mode === 'single' ? (
              <label htmlFor={ids.node}>
                {t('trigger.form.node')}
                <NodePicker
                  inputId={ids.node}
                  label={t('trigger.form.node')}
                  repoId={repoId}
                  value={node}
                  onChange={setNode}
                  placeholder={placeholder}
                  required
                />
              </label>
            ) : (
              <div className="two-col">
                <label htmlFor={ids.from}>
                  {t('trigger.form.from')}
                  <NodePicker
                    inputId={ids.from}
                    label={t('trigger.form.from')}
                    repoId={repoId}
                    value={from}
                    onChange={setFrom}
                    placeholder={placeholder}
                    required
                  />
                </label>
                <label htmlFor={ids.to}>
                  {t('trigger.form.to')}
                  <NodePicker
                    inputId={ids.to}
                    label={t('trigger.form.to')}
                    repoId={repoId}
                    value={to}
                    onChange={setTo}
                    placeholder={placeholder}
                    required
                  />
                </label>
              </div>
            )}

            <div className="actions">
              <button className="primary" type="submit" disabled={busy || repoId === ''}>
                {busy ? t('trigger.form.submitting') : t('trigger.form.submit')}
              </button>
            </div>
            <p className="muted small" id={ids.hint}>
              {t('trigger.form.hint')}
            </p>
          </form>
        </section>

        <div className="grow stack">
          {warning && (
            <div className="alert info" role="status">
              {warning}
            </div>
          )}

          {result && result.length > 0 && (
            <section className="card" aria-labelledby="created-tasks-title">
              <h2 id="created-tasks-title">{t('trigger.created.title')}</h2>
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">{t('trigger.created.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('trigger.col.task')}</th>
                      <th scope="col">{t('trigger.col.node')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col" className="actions-cell">
                        {t('common.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <Link to={`/tasks/${task.id}`}>#{task.id}</Link>
                        </td>
                        <td className="mono">{task.node}</td>
                        <td>
                          <span className={`tag ${task.status}`}>
                            {STATUS_KEYS[task.status] ? t(STATUS_KEYS[task.status]) : task.status}
                          </span>
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="link"
                            onClick={() => navigate(`/tasks/${task.id}`)}
                          >
                            {t('trigger.viewProgress')}
                            <span className="visually-hidden">
                              {t('trigger.srTask', { id: task.id })}
                            </span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="recent-manual-title">
            <div className="card-head">
              <h2 id="recent-manual-title">{t('trigger.recent.title')}</h2>
              <button
                type="button"
                className="secondary small"
                onClick={() => void recentTasks.reload()}
              >
                {t('common.refresh')}
              </button>
            </div>
            {recentTasks.loading && !recentTasks.data && (
              <p className="muted">{t('common.loading')}</p>
            )}
            {recentTasks.data && recentTasks.data.items.length === 0 && (
              <p className="muted">{t('trigger.recent.empty')}</p>
            )}
            {recentTasks.data && recentTasks.data.items.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">{t('trigger.recent.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('trigger.col.task')}</th>
                      <th scope="col">{t('trigger.col.repo')}</th>
                      <th scope="col">{t('trigger.col.node')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col">{t('trigger.col.time')}</th>
                      <th scope="col" className="actions-cell">
                        {t('common.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTasks.data.items.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <Link to={`/tasks/${task.id}`}>#{task.id}</Link>
                        </td>
                        <td>
                          {repos.data?.find((r) => r.id === task.repoId)?.name ?? `#${task.repoId}`}
                        </td>
                        <td className="mono" title={task.node}>
                          {shortHash(task.node)}
                        </td>
                        <td>
                          <span className={`tag ${task.status}`}>
                            {STATUS_KEYS[task.status] ? t(STATUS_KEYS[task.status]) : task.status}
                          </span>
                        </td>
                        <td className="small muted">{formatTime(task.createdAt)}</td>
                        <td className="actions-cell">
                          <Link to={`/tasks/${task.id}`}>
                            {t('trigger.viewProgress')}
                            <span className="visually-hidden">
                              {t('trigger.srTask', { id: task.id })}
                            </span>
                          </Link>
                        </td>
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

function shortHash(node: string): string {
  return /^[0-9a-f]{40}$/i.test(node) ? node.slice(0, 10) : node;
}
