import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

/**
 * Public read-only report view for a share link (/share/:token).
 *
 * Deliberately self-contained: no auth context, no console layout, no
 * navigation. A share token grants access to this one report only —
 * everything else on the hub requires the admin session.
 *
 * Reviewers can still record a verdict (误报 / 已修复 / 不修复) on each
 * issue; the token scopes those writes to this report.
 */

type Verdict = 'false_positive' | 'fixed' | 'wont_fix';

interface SharedIssue {
  id: number;
  file: string | null;
  line: number | null;
  endLine: number | null;
  severity: string | null;
  category: string | null;
  description: string;
  suggestion: string | null;
  feedback?: { verdict: string; note: string | null };
}

interface SharedReport {
  task: {
    id: number;
    node: string;
    status: string;
    author: string | null;
    commitMessage: string | null;
    commitDate: string | null;
    createdAt: string;
  };
  repo: { name: string; url: string; type: string };
  report: { summary: string | null; issueCount: number; parsedOk: boolean; createdAt: string };
  issues: SharedIssue[];
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
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

export default function ShareReportPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIssue, setBusyIssue] = useState<number | null>(null);
  const [reasonFor, setReasonFor] = useState<{ issueId: number; verdict: Verdict } | null>(null);
  const [reason, setReason] = useState('');
  const [feedbackError, setFeedbackError] = useState('');

  const load = () =>
    fetch(`/api/share/${encodeURIComponent(token)}/report`)
      .then(async (res) => {
        if (res.status === 404) throw new Error('分享链接不存在或已失效');
        if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
        return (await res.json()) as SharedReport;
      });

  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const sendFeedback = async (issueId: number, verdict: Verdict, note?: string) => {
    setBusyIssue(issueId);
    setFeedbackError('');
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issueId, verdict, note }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `提交失败（HTTP ${res.status}）`);
      setData(await load());
      setReasonFor(null);
      setReason('');
    } catch (e) {
      setFeedbackError((e as Error).message);
    } finally {
      setBusyIssue(null);
    }
  };

  const askReason = (issueId: number, verdict: Verdict) => {
    setReason('');
    setFeedbackError('');
    setReasonFor({ issueId, verdict });
  };

  if (error) {
    return (
      <div className="share-page">
        <div className="share-shell">
          <header className="share-head">
            <h1>代码评审报告</h1>
          </header>
          <div className="alert warn">{error}</div>
          <p className="muted">链接已失效？请联系评审平台管理员重新获取。</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="share-page">
        <div className="share-shell">
          <p className="muted">加载中…</p>
        </div>
      </div>
    );
  }

  const statusLabel = STATUS_LABELS[data.task.status] ?? data.task.status;
  const severityLabel = (v: string | null) => (v ? (SEVERITY_LABELS[v.toLowerCase()] ?? v) : '—');

  return (
    <div className="share-page">
      <div className="share-shell">
        <header className="share-head">
          <div>
            <h1>代码评审报告</h1>
            <p className="share-subtitle">
              {data.repo.name} · 节点 <code>{data.task.node}</code> · 评审
              <span className={`tag ${data.task.status}`}>{statusLabel}</span>
            </p>
          </div>
          <span className="tag">{data.report.issueCount} 条意见</span>
        </header>

        <section className="share-meta-grid">
          <div>
            <span className="share-meta-label">代码库</span>
            <span className="share-meta-value">
              {data.repo.url ? (
                <a href={data.repo.url} className="mono" target="_blank" rel="noreferrer">
                  {data.repo.url}
                </a>
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
            <span className="share-meta-value">{formatDateTime(data.report.createdAt)}</span>
          </div>
          <div className="share-meta-wide">
            <span className="share-meta-label">上库日志</span>
            <span className="share-meta-value prewrap">{data.task.commitMessage ?? '—'}</span>
          </div>
        </section>

        <section className="share-section">
          <h2>评审摘要</h2>
          <div className="prewrap report-summary">{data.report.summary ?? '（无摘要）'}</div>
          {!data.report.parsedOk && (
            <div className="alert warn">报告文件解析失败，以下为已解析的部分内容。</div>
          )}
        </section>

        <section className="share-section">
          <h2>评审意见</h2>
          {data.issues.length === 0 ? (
            <p className="muted">没有发现问题，干得漂亮。</p>
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
                  {data.issues.map((issue) => (
                    <tr key={issue.id}>
                      <td className="mono col-file">{issue.file ?? '—'}</td>
                      <td className="col-meta">
                        {issue.line
                          ? `${issue.line}${issue.endLine ? `-${issue.endLine}` : ''}`
                          : '—'}
                      </td>
                      <td className="col-meta">
                        {issue.severity ? (
                          <span className={`tag severity-${issue.severity.toLowerCase()}`}>
                            {severityLabel(issue.severity)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="col-meta">{issue.category ?? '—'}</td>
                      <td className="col-desc prewrap">
                        {issue.description}
                        {issue.suggestion && (
                          <details>
                            <summary>查看修改建议</summary>
                            <pre className="raw">{issue.suggestion}</pre>
                          </details>
                        )}
                        {issue.feedback?.verdict === 'wont_fix' && issue.feedback.note && (
                          <div className="small muted">不修复原因：{issue.feedback.note}</div>
                        )}
                      </td>
                      <td className="actions-cell">
                        {issue.feedback ? (
                          <span className="tag">{VERDICT_LABELS[issue.feedback.verdict] ?? issue.feedback.verdict}</span>
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
                              已修复
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
      </div>

      {reasonFor && (
        <div className="share-dialog-backdrop" role="presentation" onClick={() => setReasonFor(null)}>
          <div
            className="share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-reason-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="share-reason-title">
              {reasonFor.verdict === 'wont_fix' ? '填写不修复原因' : '填写误报原因（可选）'}
            </h2>
            <textarea
              className="input"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                reasonFor.verdict === 'wont_fix'
                  ? '说明为什么接受这个风险（必填，1–500 字）'
                  : '说明为什么这是误报（可选）'
              }
            />
            {feedbackError && <div className="alert error">{feedbackError}</div>}
            <div className="actions">
              <button type="button" className="secondary" onClick={() => setReasonFor(null)}>
                取消
              </button>
              <button
                type="button"
                disabled={busyIssue !== null}
                onClick={() =>
                  void sendFeedback(reasonFor.issueId, reasonFor.verdict, reason || undefined)
                }
              >
                提交
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
