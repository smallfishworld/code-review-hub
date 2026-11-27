import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type ApiError,
  type FeedbackOutcome,
  type ReportDetail,
  type ReviewVerdict,
  type Task,
  type TaskList,
  type TaskMcpAudit,
  type TaskMemoryAudit,
} from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useFlash } from '../components/Toast';
import { useI18n, type MessageKey } from '../i18n';

const STATUS_KEYS: Record<string, MessageKey> = {
  queued: 'tasks.status.queued',
  running: 'tasks.status.running',
  succeeded: 'tasks.status.succeeded',
  failed: 'tasks.status.failed',
  cancelled: 'tasks.status.cancelled',
};

const FEEDBACK_KEYS: Record<ReviewVerdict, MessageKey> = {
  false_positive: 'tasks.feedback.false_positive',
  fixed: 'tasks.feedback.fixed',
  wont_fix: 'tasks.feedback.wont_fix',
};

const SEVERITY_KEYS: Record<string, MessageKey> = {
  critical: 'tasks.severity.critical',
  high: 'tasks.severity.high',
  medium: 'tasks.severity.medium',
  low: 'tasks.severity.low',
};

const CATEGORY_KEYS: Record<string, MessageKey> = {
  bug: 'tasks.category.bug',
  security: 'tasks.category.security',
  performance: 'tasks.category.performance',
  maintainability: 'tasks.category.maintainability',
  test: 'tasks.category.test',
  style: 'tasks.category.style',
  documentation: 'tasks.category.documentation',
  other: 'tasks.category.other',
};

function RetryTaskButton({ taskId, className }: { taskId: number; className: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const flash = useFlash();
  const navigate = useNavigate();

  const retry = async () => {
    setBusy(true);
    try {
      const { task } = await api.post<{ task: Task }>(`/api/tasks/${taskId}/retry`);
      flash.ok(t('tasks.toast.retried', { id: task.id }));
      void navigate(`/tasks/${task.id}`);
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className={className} onClick={retry} disabled={busy}>
      {busy ? t('common.retrying') : t('common.retry')}
      <span className="visually-hidden">{t('trigger.srTask', { id: taskId })}</span>
    </button>
  );
}

export function TasksPage() {
  const { t, formatTime } = useI18n();
  usePageTitle(t('tasks.pageTitle'));
  const [repoId, setRepoId] = useState('');
  const [repoType, setRepoType] = useState('');
  const [status, setStatus] = useState('');
  const [trigger, setTrigger] = useState('');
  const [author, setAuthor] = useState('');
  const [node, setNode] = useState('');
  const ids = {
    repo: useId(),
    repoType: useId(),
    status: useId(),
    trigger: useId(),
    author: useId(),
    node: useId(),
  };

  const loader = useCallback(() => {
    const params = new URLSearchParams();
    if (repoId) params.set('repoId', repoId);
    if (repoType) params.set('repoType', repoType);
    if (status) params.set('status', status);
    if (trigger) params.set('trigger', trigger);
    if (author) params.set('author', author);
    if (node) params.set('node', node);
    params.set('limit', '100');
    return api.get<TaskList>(`/api/tasks?${params.toString()}`);
  }, [repoId, repoType, status, trigger, author, node]);

  const tasks = useApi(loader, [loader]);
  const repos = useApi(() => api.get<{ id: number; name: string }[]>('/api/repos'));

  const hasFilters = Boolean(repoId || repoType || status || trigger || author || node);
  const resetFilters = () => {
    setRepoId('');
    setRepoType('');
    setStatus('');
    setTrigger('');
    setAuthor('');
    setNode('');
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('tasks.pageTitle')}</h1>
          <p className="page-subtitle">{t('tasks.subtitle')}</p>
        </div>
        <div className="actions">
          {hasFilters && (
            <button type="button" className="link" onClick={resetFilters}>
              {t('tasks.clearFilters')}
            </button>
          )}
          <button type="button" className="secondary" onClick={() => void tasks.reload()}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      <section className="card toolbar-card" aria-labelledby="task-filters-title">
        <h2 id="task-filters-title" className="visually-hidden">
          {t('tasks.filtersTitle')}
        </h2>
        <div className="filter-row">
          <label htmlFor={ids.repo}>
            {t('tasks.filter.repo')}
            <select id={ids.repo} value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {repos.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.repoType}>
            {t('tasks.filter.repoType')}
            <select id={ids.repoType} value={repoType} onChange={(e) => setRepoType(e.target.value)}>
              <option value="">{t('common.all')}</option>
              <option value="svn">SVN</option>
              <option value="git">Git</option>
            </select>
          </label>
          <label htmlFor={ids.status}>
            {t('tasks.filter.status')}
            <select id={ids.status} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {Object.entries(STATUS_KEYS).map(([value, key]) => (
                <option key={value} value={value}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.trigger}>
            {t('tasks.filter.trigger')}
            <select id={ids.trigger} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="">{t('common.all')}</option>
              <option value="manual">{t('tasks.trigger.manual')}</option>
              <option value="auto">{t('tasks.trigger.auto')}</option>
            </select>
          </label>
          <label htmlFor={ids.author}>
            {t('tasks.filter.author')}
            <input
              id={ids.author}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={t('tasks.filter.authorPlaceholder')}
            />
          </label>
          <label htmlFor={ids.node}>
            {t('tasks.filter.node')}
            <input
              id={ids.node}
              value={node}
              onChange={(e) => setNode(e.target.value)}
              placeholder={t('tasks.filter.nodePlaceholder')}
            />
          </label>
        </div>
      </section>

      {tasks.loading && <p className="muted">{t('common.loading')}</p>}
      {tasks.error && (
        <div className="alert error" role="alert">
          {tasks.error}
        </div>
      )}
      {tasks.data && (
        <section className="card" aria-labelledby="task-list-title">
          <h2 id="task-list-title">
            {t('tasks.list.title')}{' '}
            <span className="muted small">{t('tasks.list.total', { total: tasks.data.total })}</span>
          </h2>
          {tasks.data.items.length === 0 && <p className="muted">{t('tasks.list.empty')}</p>}
          {tasks.data.items.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{t('tasks.list.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('tasks.col.task')}</th>
                    <th scope="col">{t('tasks.col.repo')}</th>
                    <th scope="col">{t('tasks.col.node')}</th>
                    <th scope="col">{t('tasks.col.author')}</th>
                    <th scope="col">{t('tasks.col.trigger')}</th>
                    <th scope="col">{t('tasks.col.model')}</th>
                    <th scope="col">{t('common.status')}</th>
                    <th scope="col">{t('tasks.col.createdAt')}</th>
                    <th scope="col" className="actions-cell">
                      {t('common.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.data.items.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <Link to={`/tasks/${task.id}`}>#{task.id}</Link>
                      </td>
                      <td>{repos.data?.find((r) => r.id === task.repoId)?.name ?? task.repoId}</td>
                      <td className="mono">{task.node}</td>
                      <td>{task.author ?? '—'}</td>
                      <td>
                        {task.trigger === 'auto'
                          ? t('tasks.trigger.auto')
                          : t('tasks.trigger.manual')}
                      </td>
                      <td className="nowrap small">
                        {task.providerLabel ?? t('tasks.defaultModel')}
                      </td>
                      <td>
                        <span className={`tag ${task.status}`}>
                          {STATUS_KEYS[task.status] ? t(STATUS_KEYS[task.status]) : task.status}
                        </span>
                      </td>
                      <td className="small">{formatTime(task.createdAt)}</td>
                      <td className="actions-cell">
                        {task.status === 'failed' && (
                          <RetryTaskButton taskId={task.id} className="link" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function TaskDetailPage() {
  const { id } = useParams();
  const taskId = Number(id);
  return <TaskDetail key={taskId} taskId={taskId} />;
}

function TaskDetail({ taskId }: { taskId: number }) {
  const { t, formatTime } = useI18n();
  usePageTitle(t('tasks.detail.pageTitle', { id: taskId }));
  const task = useApi(() => api.get<Task>(`/api/tasks/${taskId}`), [taskId]);
  const report = useApi(
    () => api.get<ReportDetail>(`/api/tasks/${taskId}/report`).catch(() => null),
    [taskId]
  );
  const mcpAudit = useApi(
    () => api.get<TaskMcpAudit>(`/api/tasks/${taskId}/mcp`).catch(() => null),
    [taskId]
  );
  const memoryAudit = useApi(
    () => api.get<TaskMemoryAudit>(`/api/tasks/${taskId}/memory`).catch(() => null),
    [taskId]
  );
  const flash = useFlash();
  const [busy, setBusy] = useState(false);
  const [pendingFeedback, setPendingFeedback] = useState<{
    issueId: number;
    verdict: 'false_positive' | 'wont_fix';
  } | null>(null);
  const [reason, setReason] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const feedbackDialog = useRef<HTMLDialogElement>(null);
  const feedbackTitleId = useId();
  const wontFix = pendingFeedback?.verdict === 'wont_fix';

  const severityLabel = (value: string | null): string => {
    if (!value) return '—';
    const key = SEVERITY_KEYS[value.toLowerCase()];
    return key ? t(key) : value;
  };

  const categoryLabel = (value: string | null | undefined): string => {
    if (!value) return '—';
    const key = CATEGORY_KEYS[value.toLowerCase()];
    return key ? t(key) : value;
  };

  useEffect(() => {
    const dialog = feedbackDialog.current;
    if (pendingFeedback && dialog && !dialog.open) dialog.showModal();
  }, [pendingFeedback]);

  const askForReason = (issueId: number, verdict: 'false_positive' | 'wont_fix') => {
    setReason('');
    setFeedbackError('');
    setPendingFeedback({ issueId, verdict });
  };

  const closeFeedback = () => {
    feedbackDialog.current?.close();
    setPendingFeedback(null);
  };

  const sendFeedback = async (issueId: number, verdict: ReviewVerdict, note?: string) => {
    setBusy(true);
    setFeedbackError('');
    try {
      const res = await api.post<FeedbackOutcome>(`/api/tasks/${taskId}/feedback`, {
        issueId,
        verdict,
        note,
      });
      await report.reload();
      closeFeedback();
      const label = t(FEEDBACK_KEYS[verdict]);
      flash.ok(res.memoryId === null ? label : t('tasks.detail.feedbackLinked', { label }));
    } catch (err) {
      if ((err as ApiError)?.status === 409) {
        await report.reload();
        closeFeedback();
        flash.fail(errorText(err));
      } else if (pendingFeedback) setFeedbackError(errorText(err));
      else flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const status = task.data?.status;
  const active = status === 'queued' || status === 'running';
  const reloadTask = task.reload;
  const reloadReport = report.reload;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void reloadTask();
    }, 3000);
    return () => clearInterval(timer);
  }, [active, reloadTask]);

  useEffect(() => {
    if (status === 'succeeded') void reloadReport();
  }, [status, reloadReport]);

  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/cancel`);
      flash.ok(t('tasks.toast.cancelled'));
      await task.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const item = task.data;
  const refresh = () =>
    Promise.all([task.reload(), report.reload(), mcpAudit.reload(), memoryAudit.reload()]);

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <Link to="/tasks" className="back-link">
            {t('tasks.detail.back')}
          </Link>
          <h1>{t('tasks.detail.pageTitle', { id: taskId })}</h1>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void refresh()}>
            {t('common.refresh')}
          </button>
          {active && (
            <button type="button" className="danger" onClick={cancel} disabled={busy}>
              {t('tasks.detail.cancel')}
            </button>
          )}
          {status === 'failed' && <RetryTaskButton taskId={taskId} className="secondary" />}
        </div>
      </div>

      {task.error && (
        <div className="alert error" role="alert">
          {task.error}
        </div>
      )}
      {item && (
        <section className="card" aria-labelledby="task-summary-title">
          <h2 id="task-summary-title">{t('tasks.detail.overview')}</h2>
          <div className="stat-grid cols-4">
            <div className="stat">
              <span className="stat-label">{t('common.status')}</span>
              <span className={`stat-value tag ${item.status}`}>
                {STATUS_KEYS[item.status] ? t(STATUS_KEYS[item.status]) : item.status}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.col.node')}</span>
              <span className="stat-value mono">{item.node}</span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.col.author')}</span>
              <span className="stat-value">{item.author ?? '—'}</span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.filter.trigger')}</span>
              <span className="stat-value">
                {item.trigger === 'auto' ? t('tasks.trigger.auto') : t('tasks.trigger.manual')}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.detail.reviewModel')}</span>
              <span className="stat-value small">
                {item.providerLabel ?? t('tasks.defaultModel')}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.detail.reviewEngine')}</span>
              <span className="stat-value">
                {report.data?.report.engine ?? t('tasks.detail.legacyEngine')}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.detail.injectedMeta')}</span>
              <span className="stat-value small">
                {t('tasks.detail.injectedSummary', {
                  memories: memoryAudit.data?.count ?? 0,
                  mcps: mcpAudit.data?.servers.length ?? 0,
                })}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('tasks.detail.timeRange')}</span>
              <span className="stat-value small">
                {formatTime(item.startedAt)} → {formatTime(item.finishedAt)}
              </span>
            </div>
          </div>
          {item.error && (
            <div className="alert error" role="alert">
              {t('tasks.detail.failureReason', { error: item.error })}
            </div>
          )}
        </section>
      )}

      {report.data && (
        <section className="card" aria-labelledby="task-report-title">
          <div className="card-head">
            <h2 id="task-report-title">{t('tasks.detail.reportTitle')}</h2>
            <span className="tag">
              {t('tasks.detail.issueCount', { count: report.data.issues.length })}
            </span>
          </div>
          <div className="report-summary prewrap">
            {report.data.report.summary ?? t('tasks.detail.noSummary')}
          </div>
          {!report.data.report.parsedOk && (
            <div className="alert info">{t('tasks.detail.parseFailed')}</div>
          )}
          {report.data.issues.length === 0 ? (
            <p className="muted">{t('tasks.detail.noIssues')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table report-table">
                <caption className="visually-hidden">{t('tasks.detail.issueListCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="col-file">
                      {t('tasks.detail.colFile')}
                    </th>
                    <th scope="col" className="col-meta">
                      {t('tasks.detail.colLine')}
                    </th>
                    <th scope="col" className="col-meta">
                      {t('tasks.detail.colSeverity')}
                    </th>
                    <th scope="col" className="col-meta">
                      {t('tasks.detail.colCategory')}
                    </th>
                    <th scope="col">{t('tasks.detail.colDescription')}</th>
                    <th scope="col" className="actions-cell">
                      {t('tasks.detail.colFeedback')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.issues.map((issue) => (
                    <tr key={issue.id}>
                      <td className="mono col-file">{issue.file ?? '—'}</td>
                      <td className="col-meta">{issue.line ?? '—'}</td>
                      <td className="col-meta">
                        {issue.severity ? (
                          <span className={`tag severity-${issue.severity.toLowerCase()}`}>
                            {severityLabel(issue.severity)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="col-meta">
                        {issue.category ? (
                          <span className="tag category">{categoryLabel(issue.category)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="col-desc prewrap">
                        {issue.description}
                        {issue.suggestion && (
                          <details>
                            <summary>{t('tasks.detail.viewSuggestion')}</summary>
                            <pre className="raw">{issue.suggestion}</pre>
                          </details>
                        )}
                        {issue.feedback?.verdict === 'wont_fix' && issue.feedback.note && (
                          <div className="small muted">
                            {t('tasks.detail.wontFixReason', { note: issue.feedback.note })}
                          </div>
                        )}
                      </td>
                      <td className="actions-cell">
                        {issue.feedback ? (
                          <span className="tag">{t(FEEDBACK_KEYS[issue.feedback.verdict])}</span>
                        ) : (
                          <div className="row-actions">
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => askForReason(issue.id, 'false_positive')}
                            >
                              {t('tasks.detail.markFalsePositive')}
                              <span className="visually-hidden">
                                {t('tasks.detail.srIssue', { id: issue.id })}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => void sendFeedback(issue.id, 'fixed')}
                            >
                              {t('tasks.detail.markFixed')}
                              <span className="visually-hidden">
                                {t('tasks.detail.srIssue', { id: issue.id })}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => askForReason(issue.id, 'wont_fix')}
                            >
                              {t('tasks.detail.markWontFix')}
                              <span className="visually-hidden">
                                {t('tasks.detail.srIssue', { id: issue.id })}
                              </span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(report.data.suppressedIssues?.length ?? 0) > 0 && (
            <details>
              <summary>
                {t('tasks.detail.suppressedSummary', {
                  count: report.data.suppressedIssues!.length,
                })}
              </summary>
              <ul className="audit-list">
                {report.data.suppressedIssues!.map((i) => (
                  <li key={i.id} className="small">
                    <span className="mono">{i.file ?? '—'}</span>
                    {i.line ? `:${i.line}` : ''} {i.description.slice(0, 160)}
                    <span className="muted">
                      {t('tasks.detail.suppressedBy', { id: i.suppressedBy ?? '' })}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.data.raw && (
            <details>
              <summary>{t('tasks.detail.viewRawJson')}</summary>
              <pre className="raw">{report.data.raw}</pre>
            </details>
          )}
        </section>
      )}

      {item && !report.data && item.status === 'succeeded' && (
        <p className="muted">{t('tasks.detail.reportPending')}</p>
      )}

      {((mcpAudit.data && mcpAudit.data.servers.length > 0) ||
        (memoryAudit.data && memoryAudit.data.count > 0)) && (
        <div className="audit-grid">
          {mcpAudit.data && mcpAudit.data.servers.length > 0 && (
            <section className="card" aria-labelledby="task-mcp-title">
              <h2 id="task-mcp-title">{t('tasks.detail.mcpAuditTitle')}</h2>
              <ul className="audit-list">
                {mcpAudit.data.servers.map((s) => (
                  <li key={s.serverId} className="small">
                    <span className="mono">{s.serverName}</span>
                    {s.allowlistEnforced ? '' : t('tasks.detail.allowlistNotEnforced')}
                    {s.toolStats ? (
                      <span>
                        {' '}
                        {t('tasks.detail.toolStatsLabel')}
                        {Object.entries(s.toolStats)
                          .map(([tool, v]) =>
                            t('tasks.detail.toolStatItem', {
                              tool,
                              calls: v.calls,
                              failures: v.failures,
                            })
                          )
                          .join(', ')}
                      </span>
                    ) : (
                      <span className="muted">{t('tasks.detail.statsNotReported')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {memoryAudit.data && memoryAudit.data.count > 0 && (
            <section className="card" aria-labelledby="task-memory-title">
              <h2 id="task-memory-title">
                {t('tasks.detail.memoryAuditTitle', { count: memoryAudit.data.count })}
              </h2>
              <ul className="audit-list">
                {memoryAudit.data.entries.map((m) => (
                  <li key={m.id} className="small">
                    <span className="tag">{m.kind}</span> {m.title}
                    {m.scope ? <span className="muted"> ({m.scope})</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      <dialog
        ref={feedbackDialog}
        className="confirm"
        aria-labelledby={feedbackTitleId}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) closeFeedback();
        }}
      >
        {pendingFeedback && (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const note = reason.trim();
              if (busy || (wontFix && !note)) return;
              void sendFeedback(pendingFeedback.issueId, pendingFeedback.verdict, note || undefined);
            }}
          >
            <h2 id={feedbackTitleId}>
              {wontFix ? t('tasks.detail.dialogWontFixTitle') : t('tasks.detail.dialogFpTitle')}
            </h2>
            <label>
              {wontFix ? t('tasks.detail.dialogWontFixLabel') : t('tasks.detail.dialogFpLabel')}
              <textarea
                rows={4}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required={wontFix}
                maxLength={wontFix ? 500 : undefined}
                readOnly={busy}
                autoFocus
              />
            </label>
            {feedbackError && (
              <div className="alert error" role="alert">
                {feedbackError}
              </div>
            )}
            <div className="actions">
              <button type="button" onClick={closeFeedback} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || (wontFix && !reason.trim())}
              >
                {busy ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
