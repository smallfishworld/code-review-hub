import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useFlash } from '../components/Toast';
import { copyText } from '../utils/clipboard';

/**
 * Public read-only report view for a share link (/share/:token).
 *
 * Deliberately self-contained: no console layout, no navigation. A share token
 * grants access to this one report only — everything else on the hub requires
 * the admin session.
 *
 * Developers can record a verdict (误报 / 已修复 / 不修复) on each issue; the
 * token scopes those writes to this report and persists them into project memory.
 */

type Verdict = 'false_positive' | 'fixed' | 'wont_fix';
type ProgressFilter = 'all' | 'pending' | 'handled';

interface SharedIssue {
  id: number;
  file: string | null;
  line: number | null;
  endLine: number | null;
  severity: string | null;
  category: string | null;
  description: string;
  suggestion: string | null;
  feedback?: {
    verdict: string;
    note: string | null;
    operatorName?: string | null;
    clientIp?: string | null;
    clientInfo?: string | null;
  };
}

interface SharedReport {
  task: {
    id: number;
    node: string;
    status: string;
    author: string | null;
    error: string | null;
    commitMessage: string | null;
    commitDate: string | null;
    createdAt: string;
  };
  repo: { name: string; url: string; type: string };
  report: { summary: string | null; issueCount: number; parsedOk: boolean; createdAt: string } | null;
  issues: SharedIssue[];
}

interface ShareFeedbackResponse {
  feedbackId: number;
  memoryId: number | null;
  memoryAction: 'created' | 'reinforced' | 'none';
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
};

const CATEGORY_LABELS: Record<string, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
  test: '测试',
  style: '风格',
  documentation: '文档',
  other: '其他',
};

const STATUS_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  running: '执行中',
  queued: '排队中',
};

const VERDICT_LABELS: Record<string, string> = {
  false_positive: '已标误报',
  fixed: '已标修复',
  wont_fix: '已标不修复',
};

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatLineRange(line: number | null, endLine: number | null): string {
  if (!line) return '—';
  if (endLine && endLine !== line) return `${line}-${endLine}`;
  return String(line);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

const OPERATOR_STORAGE_KEY = 'crp_share_operator';

function collectClientInfo(): string {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || navigator.platform || '';
    const lang = navigator.language || '';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return [platform, lang, tz].filter(Boolean).join(' / ');
  } catch {
    return '';
  }
}

export default function ShareReportPage() {
  const { token = '' } = useParams<{ token: string }>();
  return <ShareReportView key={token} token={token} />;
}

function ShareReportView({ token }: { token: string }) {
  const flash = useFlash();
  const [data, setData] = useState<SharedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIssue, setBusyIssue] = useState<number | null>(null);
  const [reasonFor, setReasonFor] = useState<{ issueId: number; verdict: 'false_positive' | 'wont_fix' } | null>(null);
  const [reason, setReason] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>('all');
  const [operatorName, setOperatorName] = useState<string>(() => {
    try {
      return localStorage.getItem(OPERATOR_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const reasonDialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleId = useId();

  const updateOperatorName = (value: string) => {
    setOperatorName(value);
    try {
      localStorage.setItem(OPERATOR_STORAGE_KEY, value);
    } catch {
      // ignore storage errors
    }
  };

  const load = useCallback(async () => {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}/report`);
    if (res.status === 404) throw new Error('分享链接不存在或已失效');
    if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
    return (await res.json()) as SharedReport;
  }, [token]);

  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(() => {
    if (data) {
      document.title = `${data.repo.name} · ${data.task.node} — 代码评审报告`;
    } else {
      document.title = '代码评审报告';
    }
  }, [data]);

  useEffect(() => {
    const dialog = reasonDialogRef.current;
    if (reasonFor && dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [reasonFor]);

  const closeReasonDialog = () => {
    reasonDialogRef.current?.close();
    setReasonFor(null);
    setReason('');
    setFeedbackError('');
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      setData(await load());
    } catch (e) {
      flash.fail((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const sendFeedback = async (issueId: number, verdict: Verdict, note?: string) => {
    const trimmedNote = note?.trim();
    if (verdict === 'wont_fix' && (!trimmedNote || trimmedNote.length > 500)) {
      setFeedbackError('请填写不修复原因（1–500 字符）');
      return;
    }
    setBusyIssue(issueId);
    setFeedbackError('');
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueId,
          verdict,
          note: trimmedNote || undefined,
          operatorName: operatorName.trim() || undefined,
          clientInfo: collectClientInfo() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ShareFeedbackResponse> & {
        message?: string;
      };
      if (!res.ok) {
        const message = body.message ?? `提交失败（HTTP ${res.status}）`;
        if (res.status === 409) {
          // Another teammate already marked this issue: refresh so the latest
          // verdict is visible immediately.
          await load().then(setData).catch(() => {});
          closeReasonDialog();
          flash.fail(message);
          return;
        }
        if (reasonFor) {
          setFeedbackError(message);
        } else {
          flash.fail(message);
        }
        return;
      }
      setData(await load());
      closeReasonDialog();
      const label = VERDICT_LABELS[verdict] ?? verdict;
      flash.ok(body.memoryId ? `${label}，已写入项目记忆` : label);
    } catch (e) {
      const message = (e as Error).message || '提交失败，请稍后重试';
      if (reasonFor) {
        setFeedbackError(message);
      } else {
        flash.fail(message);
      }
    } finally {
      setBusyIssue(null);
    }
  };

  const askReason = (issueId: number, verdict: 'false_positive' | 'wont_fix') => {
    setReason('');
    setFeedbackError('');
    setReasonFor({ issueId, verdict });
  };

  const stats = useMemo(() => {
    const issues = data?.issues ?? [];
    const bySeverity: Record<string, number> = {};
    let handled = 0;
    for (const issue of issues) {
      const sev = issue.severity?.toLowerCase();
      if (sev) bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      if (issue.feedback) handled++;
    }
    return { total: issues.length, handled, pending: issues.length - handled, bySeverity };
  }, [data]);

  const filteredIssues = useMemo(() => {
    const issues = data?.issues ?? [];
    return issues.filter((issue) => {
      if (severityFilter !== 'all' && (issue.severity?.toLowerCase() ?? '') !== severityFilter) {
        return false;
      }
      if (progressFilter === 'pending' && issue.feedback) return false;
      if (progressFilter === 'handled' && !issue.feedback) return false;
      return true;
    });
  }, [data, severityFilter, progressFilter]);

  if (error) {
    return (
      <div className="share-page">
        <div className="share-shell">
          <header className="share-head">
            <h1>代码评审报告</h1>
          </header>
          <section className="card">
            <div className="alert warn">{error}</div>
            <p className="muted">链接已失效？请联系评审平台管理员重新获取。</p>
          </section>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="share-page">
        <div className="share-shell">
          <section className="card">
            <p className="muted">加载中…</p>
          </section>
        </div>
      </div>
    );
  }

  const statusLabel = STATUS_LABELS[data.task.status] ?? data.task.status;
  const severityLabel = (v: string | null) => (v ? (SEVERITY_LABELS[v.toLowerCase()] ?? v) : '—');
  const categoryLabel = (v: string | null) => (v ? (CATEGORY_LABELS[v.toLowerCase()] ?? v) : '—');
  const repoTypeLower = data.repo.type.toLowerCase();
  const isWontFix = reasonFor?.verdict === 'wont_fix';
  const activeSeverities = SEVERITY_ORDER.filter((s) => (stats.bySeverity[s] ?? 0) > 0);
  const isPendingTask = data.task.status === 'queued' || data.task.status === 'running';

  return (
    <div className="share-page">
      <div className="share-shell">
        <header className="share-head">
          <div className="share-head-main">
            <div className="share-title-row">
              <h1>代码评审报告</h1>
              {data.repo.type && (
                <span className={`tag ${repoTypeLower}`}>{data.repo.type.toUpperCase()}</span>
              )}
              <span className={`tag ${data.task.status}`}>评审{statusLabel}</span>
            </div>
            <p className="share-subtitle">
              <strong>{data.repo.name}</strong>
              <span aria-hidden="true">·</span>
              <span>
                节点 <code>{data.task.node}</code>
              </span>
              {data.task.author && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>上库人 {data.task.author}</span>
                </>
              )}
            </p>
          </div>
          <div className="share-head-right">
            {data.report && (
              <span className="tag share-count-tag">
                {stats.total === 0
                  ? '0 条意见'
                  : stats.handled > 0
                    ? `${stats.total} 条意见 · 已处理 ${stats.handled}`
                    : `${stats.total} 条意见`}
              </span>
            )}
            <button
              type="button"
              className="secondary small"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        </header>

        <section className="share-meta-grid" aria-label="提交与任务信息">
          <div>
            <span className="share-meta-label">代码库</span>
            <span className="share-meta-value">
              {data.repo.url ? (
                isHttpUrl(data.repo.url) ? (
                  <a href={data.repo.url} className="mono" target="_blank" rel="noreferrer">
                    {data.repo.url}
                  </a>
                ) : (
                  <span className="mono">{data.repo.url}</span>
                )
              ) : (
                <span className="muted">未配置代码库地址</span>
              )}
            </span>
          </div>
          <div>
            <span className="share-meta-label">上库节点</span>
            <span className="share-meta-value mono">{data.task.node}</span>
          </div>
          <div>
            <span className="share-meta-label">上库人员</span>
            <span className="share-meta-value">{data.task.author ?? '—'}</span>
          </div>
          <div>
            <span className="share-meta-label">上库时间</span>
            <span className="share-meta-value">{formatDateTime(data.task.commitDate)}</span>
          </div>
          <div>
            <span className="share-meta-label">评审时间</span>
            <span className="share-meta-value">
              {formatDateTime(data.report?.createdAt ?? data.task.createdAt)}
            </span>
          </div>
          <div className="share-meta-wide">
            <span className="share-meta-label">上库日志</span>
            <span className="share-meta-value prewrap">{data.task.commitMessage || '—'}</span>
          </div>
        </section>

        {!data.report ? (
          <section className="card share-card">
            <h2>评审结果</h2>
            {data.task.status === 'failed' ? (
              <div className="alert error" role="alert">
                评审执行失败：{data.task.error || '未知错误，请联系评审平台管理员查看任务日志。'}
              </div>
            ) : isPendingTask ? (
              <div className="alert info">
                评审任务当前处于「{statusLabel}」状态，完成后请点击右上角「刷新」查看完整报告。
              </div>
            ) : (
              <div className="alert warn">
                该评审任务{data.task.status === 'cancelled' ? '已取消' : '暂无可用报告'}。
              </div>
            )}
          </section>
        ) : (
          <>
            <section className="card share-card">
              <div className="card-head">
                <h2>评审摘要</h2>
                {stats.total > 0 && (
                  <div className="share-severity-strip" aria-label="严重度分布">
                    {activeSeverities.map((sev) => (
                      <span key={sev} className={`tag severity-${sev}`}>
                        {SEVERITY_LABELS[sev]} {stats.bySeverity[sev]}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="prewrap report-summary">{data.report.summary ?? '（无摘要）'}</div>
              {!data.report.parsedOk && (
                <div className="alert warn">报告文件解析失败，以下为已解析的部分内容。</div>
              )}
            </section>

            <section className="card share-card">
              <div className="card-head share-issues-head">
                <div>
                  <h2>评审意见</h2>
                  {stats.total > 0 && (
                    <div className="share-operator-bar">
                      <p className="small muted share-hint">
                        点击右侧「误报 / 已修复 / 不修复」可直接标记并将结果写入项目记忆（将记录操作人、IP 与设备信息）。
                      </p>
                      <label className="share-operator-field">
                        <span className="small muted">操作人 / 电脑用户名：</span>
                        <input
                          value={operatorName}
                          onChange={(e) => updateOperatorName(e.target.value)}
                          placeholder="可选，如 zhangsan（自动记住）"
                          maxLength={60}
                        />
                      </label>
                    </div>
                  )}
                </div>
                {stats.total > 0 && (
                  <div className="share-filters" role="group" aria-label="筛选评审意见">
                    <div className="share-filter-group">
                      <button
                        type="button"
                        className={`share-filter-pill ${progressFilter === 'all' ? 'active' : ''}`}
                        onClick={() => setProgressFilter('all')}
                      >
                        全部 ({stats.total})
                      </button>
                      <button
                        type="button"
                        className={`share-filter-pill ${progressFilter === 'pending' ? 'active' : ''}`}
                        onClick={() => setProgressFilter('pending')}
                      >
                        待处理 ({stats.pending})
                      </button>
                      <button
                        type="button"
                        className={`share-filter-pill ${progressFilter === 'handled' ? 'active' : ''}`}
                        onClick={() => setProgressFilter('handled')}
                      >
                        已处理 ({stats.handled})
                      </button>
                    </div>
                    {activeSeverities.length > 1 && (
                      <div className="share-filter-group">
                        <button
                          type="button"
                          className={`share-filter-pill ${severityFilter === 'all' ? 'active' : ''}`}
                          onClick={() => setSeverityFilter('all')}
                        >
                          全部级别
                        </button>
                        {activeSeverities.map((sev) => (
                          <button
                            key={sev}
                            type="button"
                            className={`share-filter-pill ${severityFilter === sev ? 'active' : ''}`}
                            onClick={() => setSeverityFilter(sev)}
                          >
                            {SEVERITY_LABELS[sev]} ({stats.bySeverity[sev]})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {stats.total === 0 ? (
                <div className="alert ok share-clean-banner">没有发现问题，干得漂亮。</div>
              ) : filteredIssues.length === 0 ? (
                <div className="actions">
                  <span className="muted">当前筛选条件下没有匹配的评审意见。</span>
                  <button
                    type="button"
                    className="link small"
                    onClick={() => {
                      setSeverityFilter('all');
                      setProgressFilter('all');
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table report-table">
                    <thead>
                      <tr>
                        <th className="col-file">文件</th>
                        <th className="col-meta">行</th>
                        <th className="col-meta">严重度</th>
                        <th className="col-meta">类型</th>
                        <th>说明</th>
                        <th className="actions-cell">处理</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredIssues.map((issue) => (
                        <tr key={issue.id} className={issue.feedback ? 'issue-handled' : undefined}>
                          <td className="mono col-file">{issue.file ?? '—'}</td>
                          <td className="col-meta mono">{formatLineRange(issue.line, issue.endLine)}</td>
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
                              <details className="share-suggestion">
                                <summary>查看修改建议</summary>
                                <div className="share-suggestion-actions">
                                  <button
                                    type="button"
                                    className="link small"
                                    onClick={() =>
                                      void copyText(issue.suggestion!).then((ok) =>
                                        ok ? flash.ok('已复制修改建议') : flash.fail('复制失败，请手动复制')
                                      )
                                    }
                                  >
                                    复制建议
                                  </button>
                                </div>
                                <pre className="raw">{issue.suggestion}</pre>
                              </details>
                            )}
                            {issue.feedback?.note && (
                              <div className="small muted share-feedback-note">
                                {issue.feedback.verdict === 'wont_fix'
                                  ? `不修复原因：${issue.feedback.note}`
                                  : `误报原因：${issue.feedback.note}`}
                              </div>
                            )}
                            {issue.feedback && (issue.feedback.operatorName || issue.feedback.clientIp) && (
                              <div className="small muted share-feedback-meta">
                                操作记录：
                                {[
                                  issue.feedback.operatorName,
                                  issue.feedback.clientIp ? `IP ${issue.feedback.clientIp}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                            )}
                          </td>
                          <td className="actions-cell">
                            {issue.feedback ? (
                              <span className={`tag verdict-${issue.feedback.verdict}`}>
                                {VERDICT_LABELS[issue.feedback.verdict] ?? issue.feedback.verdict}
                              </span>
                            ) : (
                              <div className="row-actions">
                                <button
                                  type="button"
                                  className="link"
                                  disabled={busyIssue !== null}
                                  onClick={() => askReason(issue.id, 'false_positive')}
                                >
                                  误报
                                </button>
                                <button
                                  type="button"
                                  className="link"
                                  disabled={busyIssue !== null}
                                  onClick={() => void sendFeedback(issue.id, 'fixed')}
                                >
                                  {busyIssue === issue.id ? '提交中…' : '已修复'}
                                </button>
                                <button
                                  type="button"
                                  className="link"
                                  disabled={busyIssue !== null}
                                  onClick={() => askReason(issue.id, 'wont_fix')}
                                >
                                  不修复
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
            </section>
          </>
        )}
      </div>

      <dialog
        ref={reasonDialogRef}
        className="confirm"
        aria-labelledby={dialogTitleId}
        onCancel={(event) => {
          event.preventDefault();
          if (busyIssue === null) closeReasonDialog();
        }}
      >
        {reasonFor && (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              if (busyIssue !== null) return;
              void sendFeedback(reasonFor.issueId, reasonFor.verdict, reason);
            }}
          >
            <h2 id={dialogTitleId}>
              {isWontFix ? '填写不修复原因' : '填写误报原因（可选）'}
            </h2>
            <label>
              <span className="share-dialog-label-row">
                <span>
                  {isWontFix
                    ? '说明为什么接受这个风险（必填，写入项目记忆）'
                    : '说明为什么这是误报（可选，将作为抑制记忆标题）'}
                </span>
                {isWontFix && (
                  <span className="small muted">{reason.trim().length}/500</span>
                )}
              </span>
              <textarea
                rows={4}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required={isWontFix}
                maxLength={isWontFix ? 500 : undefined}
                readOnly={busyIssue !== null}
                autoFocus
                placeholder={
                  isWontFix
                    ? '例如：兼容旧客户端，保留现有行为'
                    : '例如：上游调用方已保证非空'
                }
              />
            </label>
            {feedbackError && (
              <div className="alert error" role="alert">
                {feedbackError}
              </div>
            )}
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busyIssue !== null}
                onClick={closeReasonDialog}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busyIssue !== null || (isWontFix && !reason.trim())}
              >
                {busyIssue !== null ? '提交中…' : '提交'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
