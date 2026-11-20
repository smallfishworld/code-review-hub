import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type ReportDetail,
  type ReportIssue,
  type Task,
  type TaskList,
  type TaskMcpAudit,
  type TaskMemoryAudit,
} from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useFlash } from '../components/Toast';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

/** ocr severity values (critical/high/medium/low) → 中文标签 + tag class. */
const SEVERITY_LABEL: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
};

/** ocr issue categories → 中文标签. */
const CATEGORY_LABEL: Record<string, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
  test: '测试',
  style: '风格',
  documentation: '文档',
  other: '其他',
};

function severityLabel(value: string | null): string {
  if (!value) return '—';
  return SEVERITY_LABEL[value.toLowerCase()] ?? value;
}

function categoryLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return CATEGORY_LABEL[value.toLowerCase()] ?? value;
}

export function TasksPage() {
  usePageTitle('任务与报告');
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
        <h1>任务与报告</h1>
        <div className="actions">
          {hasFilters && (
            <button type="button" className="link" onClick={resetFilters}>
              清除筛选
            </button>
          )}
          <button type="button" className="secondary" onClick={() => void tasks.reload()}>
            刷新
          </button>
        </div>
      </div>

      <section className="card" aria-labelledby="task-filters-title">
        <h2 id="task-filters-title">筛选</h2>
        <div className="filter-row">
          <label htmlFor={ids.repo}>
            仓库
            <select id={ids.repo} value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="">全部</option>
              {repos.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.repoType}>
            仓库类型
            <select id={ids.repoType} value={repoType} onChange={(e) => setRepoType(e.target.value)}>
              <option value="">全部</option>
              <option value="svn">SVN</option>
              <option value="git">Git</option>
            </select>
          </label>
          <label htmlFor={ids.status}>
            状态
            <select id={ids.status} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.trigger}>
            触发方式
            <select id={ids.trigger} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="">全部</option>
              <option value="manual">手动</option>
              <option value="auto">自动监控</option>
            </select>
          </label>
          <label htmlFor={ids.author}>
            作者
            <input
              id={ids.author}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="精确匹配"
            />
          </label>
          <label htmlFor={ids.node}>
            节点
            <input
              id={ids.node}
              value={node}
              onChange={(e) => setNode(e.target.value)}
              placeholder="包含匹配"
            />
          </label>
        </div>
      </section>

      {tasks.loading && <p className="muted">加载中…</p>}
      {tasks.error && (
        <div className="alert error" role="alert">
          {tasks.error}
        </div>
      )}
      {tasks.data && (
        <section className="card" aria-labelledby="task-list-title">
          <h2 id="task-list-title">
            任务列表 <span className="muted small">共 {tasks.data.total} 个</span>
          </h2>
          {tasks.data.items.length === 0 && <p className="muted">没有符合条件的任务。</p>}
          {tasks.data.items.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">评审任务列表</caption>
                <thead>
                  <tr>
                    <th scope="col">任务</th>
                    <th scope="col">仓库</th>
                    <th scope="col">节点</th>
                    <th scope="col">作者</th>
                    <th scope="col">触发</th>
                    <th scope="col">状态</th>
                    <th scope="col">创建时间</th>
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
                      <td>{task.trigger === 'auto' ? '自动监控' : '手动'}</td>
                      <td>
                        <span className={`tag ${task.status}`}>{STATUS_LABEL[task.status]}</span>
                      </td>
                      <td className="small">{formatTime(task.createdAt)}</td>
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
  usePageTitle(`任务 #${taskId}`);
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
  const [feedbackDone, setFeedbackDone] = useState<Record<number, string>>({});

  const sendFeedback = async (issue: ReportIssue, verdict: 'false_positive' | 'fixed') => {
    const note = verdict === 'false_positive' ? window.prompt('误报原因（可选）：') ?? '' : '';
    if (verdict === 'false_positive' && note === null) return;
    setBusy(true);
    try {
      const res = await api.post<{ memoryAction: string }>(`/api/tasks/${taskId}/feedback`, {
        issueId: issue.id,
        verdict,
        note: note || undefined,
      });
      setFeedbackDone((prev) => ({ ...prev, [issue.id]: verdict }));
      flash.ok(
        verdict === 'false_positive'
          ? `已标记误报（${res.memoryAction === 'created' ? '新建' : res.memoryAction === 'reinforced' ? '强化' : '关联'}抑制记忆）`
          : '已标记修复（生成历史记忆）'
      );
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // The page is the "查看进度" target after triggering a review, so it has to
  // follow the task on its own — otherwise it shows 执行中 forever until the
  // user finds the 刷新 button. Poll while active, then load the report once.
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
      flash.ok('已请求取消任务');
      await task.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const t = task.data;

  return (
    <div>
      <div className="page-head">
        <h1>任务 #{taskId}</h1>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void task.reload()}>
            刷新
          </button>
          {active && (
            <button type="button" className="danger" onClick={cancel} disabled={busy}>
              取消任务
            </button>
          )}
        </div>
      </div>

      {task.error && (
        <div className="alert error" role="alert">
          {task.error}
        </div>
      )}
      {t && (
        <section className="card" aria-labelledby="task-summary-title">
          <h2 id="task-summary-title">概览</h2>
          <div className="stat-grid">
            <div className="stat">
              <span className="stat-label">状态</span>
              <span className={`stat-value tag ${t.status}`}>{STATUS_LABEL[t.status]}</span>
            </div>
            <div className="stat">
              <span className="stat-label">节点</span>
              <span className="stat-value mono">{t.node}</span>
            </div>
            <div className="stat">
              <span className="stat-label">作者</span>
              <span className="stat-value">{t.author ?? '—'}</span>
            </div>
            <div className="stat">
              <span className="stat-label">触发方式</span>
              <span className="stat-value">{t.trigger === 'auto' ? '自动监控' : '手动'}</span>
            </div>
            <div className="stat">
              <span className="stat-label">评审引擎</span>
              <span className="stat-value">{report.data?.report.engine ?? 'ocr（历史）'}</span>
            </div>
            <div className="stat">
              <span className="stat-label">注入记忆 / MCP</span>
              <span className="stat-value small">
                {memoryAudit.data?.count ?? 0} 条记忆 · {mcpAudit.data?.servers.length ?? 0} 个 MCP
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">开始 / 结束</span>
              <span className="stat-value small">
                {formatTime(t.startedAt)} → {formatTime(t.finishedAt)}
              </span>
            </div>
          </div>
          {t.error && (
            <div className="alert error" role="alert">
              失败原因：{t.error}
            </div>
          )}
        </section>
      )}

      {report.data && (
        <section className="card" aria-labelledby="task-report-title">
          <h2 id="task-report-title">评审报告</h2>
          <p className="prewrap">{report.data.report.summary ?? '（无摘要）'}</p>
          {!report.data.report.parsedOk && (
            <div className="alert info">报告解析失败，已保留原文。</div>
          )}
          {report.data.issues.length === 0 ? (
            <p className="muted">未发现评审问题。</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">评审问题列表</caption>
                <thead>
                  <tr>
                    <th scope="col">文件</th>
                    <th scope="col">行号</th>
                    <th scope="col">级别</th>
                    <th scope="col">缺陷类型</th>
                    <th scope="col">问题描述与建议</th>
                    <th scope="col" className="actions-cell">
                      反馈
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.issues.map((issue) => (
                    <tr key={issue.id}>
                      <td className="mono">{issue.file ?? '—'}</td>
                      <td>{issue.line ?? '—'}</td>
                      <td>
                        {issue.severity ? (
                          <span className={`tag severity-${issue.severity.toLowerCase()}`}>
                            {severityLabel(issue.severity)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {issue.category ? (
                          <span className="tag category">{categoryLabel(issue.category)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="prewrap">
                        {issue.description}
                        {issue.suggestion && (
                          <details>
                            <summary>查看建议代码</summary>
                            <pre className="raw">{issue.suggestion}</pre>
                          </details>
                        )}
                      </td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="link"
                            disabled={busy || feedbackDone[issue.id] !== undefined}
                            onClick={() => void sendFeedback(issue, 'false_positive')}
                          >
                            {feedbackDone[issue.id] === 'false_positive' ? '已标误报' : '误报'}
                            <span className="visually-hidden">issue {issue.id}</span>
                          </button>
                          <button
                            type="button"
                            className="link"
                            disabled={busy || feedbackDone[issue.id] !== undefined}
                            onClick={() => void sendFeedback(issue, 'fixed')}
                          >
                            {feedbackDone[issue.id] === 'fixed' ? '已标修复' : '已修复'}
                            <span className="visually-hidden">issue {issue.id}</span>
                          </button>
                        </div>
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
                已被项目记忆确定性抑制的问题（{report.data.suppressedIssues!.length} 条，默认不展示）
              </summary>
              <ul>
                {report.data.suppressedIssues!.map((i) => (
                  <li key={i.id} className="small">
                    <span className="mono">{i.file ?? '—'}</span>
                    {i.line ? `:${i.line}` : ''} {i.description.slice(0, 160)}
                    <span className="muted">（命中记忆 #{i.suppressedBy}）</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {report.data.raw && (
            <details>
              <summary>查看原始 JSON</summary>
              <pre className="raw">{report.data.raw}</pre>
            </details>
          )}
        </section>
      )}

      {t && !report.data && t.status === 'succeeded' && (
        <p className="muted">报告索引尚未生成，请稍后刷新。</p>
      )}

      {mcpAudit.data && mcpAudit.data.servers.length > 0 && (
        <section className="card" aria-labelledby="task-mcp-title">
          <h2 id="task-mcp-title">MCP 注入审计</h2>
          <ul>
            {mcpAudit.data.servers.map((s) => (
              <li key={s.serverId} className="small">
                <span className="mono">{s.serverName}</span>
                {s.allowlistEnforced ? '' : '（白名单未强制执行——引擎不支持按工具过滤）'}
                {s.toolStats ? (
                  <span>
                    {' '}
                    调用统计：
                    {Object.entries(s.toolStats)
                      .map(([tool, v]) => `${tool} ${v.calls}次/失败${v.failures}`)
                      .join('，')}
                  </span>
                ) : (
                  <span className="muted">（引擎未上报工具统计）</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {memoryAudit.data && memoryAudit.data.count > 0 && (
        <section className="card" aria-labelledby="task-memory-title">
          <h2 id="task-memory-title">注入的项目记忆（{memoryAudit.data.count} 条）</h2>
          <ul>
            {memoryAudit.data.entries.map((m) => (
              <li key={m.id} className="small">
                <span className="tag">{m.kind}</span> {m.title}
                {m.scope ? <span className="muted">（{m.scope}）</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
