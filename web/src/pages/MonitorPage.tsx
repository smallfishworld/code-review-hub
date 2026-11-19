import { useEffect, useId, useState } from 'react';
import { api, type MonitorRule, type Repo } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useFlash } from '../components/Toast';

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

/** monitor_state.init_status values → Chinese labels. */
const INIT_LABEL: Record<string, string> = {
  ready: '就绪',
  cloning: '初始化中（克隆中）',
  failed: '初始化失败',
};

export function MonitorPage() {
  usePageTitle('监控规则');
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
      setFormError('轮询间隔必须是不小于 30 的整数（秒）');
      return;
    }
    if (!Number.isInteger(form.backtrackNodes) || form.backtrackNodes < 0) {
      setFormError('回溯节点数必须是非负整数');
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
      flash.ok('监控规则已保存');
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
        <h1>监控规则</h1>
        <button type="button" className="secondary" onClick={() => void rules.reload()}>
          刷新状态
        </button>
      </div>

      {repos.data && repos.data.length === 0 && (
        <div className="alert info">还没有仓库，请先在「仓库管理」中添加。</div>
      )}

      {repos.data && repos.data.length > 0 && (
        <div className="split">
          <section className="card" aria-labelledby="rule-form-title">
            <h2 id="rule-form-title">规则配置</h2>
            {/* noValidate: the handler below shows a Chinese range message
                instead of the browser's native tooltip. */}
            <form className="form" onSubmit={save} noValidate aria-describedby={ids.hint}>
              <label htmlFor={ids.repo}>
                仓库
                <select
                  id={ids.repo}
                  value={selectedRepo ?? ''}
                  onChange={(e) => setSelectedRepo(Number(e.target.value))}
                >
                  {repos.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}（{r.type.toUpperCase()}）
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={ids.interval}>
                轮询间隔（秒，≥30）
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
              <label htmlFor={ids.authors}>
                上库人员白名单（每行一个，留空不过滤）
                <textarea
                  id={ids.authors}
                  rows={3}
                  value={form.authorWhitelist}
                  onChange={(e) => setForm({ ...form, authorWhitelist: e.target.value })}
                  placeholder={'zhangsan\nlisi'}
                />
              </label>
              <label htmlFor={ids.paths}>
                路径前缀（每行一个，留空不过滤）
                <textarea
                  id={ids.paths}
                  rows={3}
                  value={form.pathPrefixes}
                  onChange={(e) => setForm({ ...form, pathPrefixes: e.target.value })}
                  placeholder={'trunk/src/\nsrc/main/'}
                />
              </label>
              <label htmlFor={ids.backtrack}>
                回溯节点数（首次启用时向前回溯，0 表示从最新节点开始）
                <input
                  id={ids.backtrack}
                  type="number"
                  min={0}
                  value={form.backtrackNodes}
                  onChange={(e) => setForm({ ...form, backtrackNodes: Number(e.target.value) })}
                />
              </label>
              {repo?.type === 'git' && (
                <p className="muted small">监控分支：{repo.branch ?? 'main'}（在「仓库管理」中修改）</p>
              )}
              {formError && (
                <div className="alert error" role="alert">
                  {formError}
                </div>
              )}
              <div className="actions">
                <button className="primary" type="submit" disabled={busy}>
                  保存规则
                </button>
                {currentRule && (
                  <button
                    type="button"
                    className={currentRule.enabled ? 'secondary' : 'primary'}
                    disabled={busy}
                    onClick={() =>
                      currentRule.enabled
                        ? action('disable', '监控已停用')
                        : action('enable', '监控已启用')
                    }
                  >
                    {currentRule.enabled ? '停用监控' : '启用监控'}
                  </button>
                )}
                {currentRule && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => action('poll', '已执行一次轮询')}
                  >
                    立即轮询
                  </button>
                )}
              </div>
              <p className="muted small" id={ids.hint}>
                人员白名单与路径前缀同时配置时需同时命中（AND）。未命中的节点会记录跳过原因。
              </p>
            </form>
          </section>

          <section className="card grow" aria-labelledby="monitor-status-title">
            <h2 id="monitor-status-title">监控状态</h2>
            {!currentRule && <p className="muted">该仓库尚未配置监控规则。</p>}
            {currentRule && status && (
              <>
                <div className="stat-grid">
                  <div className="stat">
                    <span className="stat-label">状态</span>
                    <span className={currentRule.enabled ? 'stat-value ok' : 'stat-value off'}>
                      {currentRule.enabled ? '监控中' : '已停用'}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">间隔</span>
                    <span className="stat-value">{currentRule.intervalSeconds}s</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">最新节点</span>
                    <span className="stat-value mono">{status.headNode ?? '—'}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">已处理位置</span>
                    <span className="stat-value mono">{status.lastNode ?? '—'}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">最近轮询</span>
                    <span className="stat-value">{formatTime(status.lastPollAt)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">初始化</span>
                    <span className="stat-value">{INIT_LABEL[status.initStatus] ?? status.initStatus}</span>
                  </div>
                </div>
                {status.initStatus === 'cloning' && (
                  <div className="alert info">
                    Git 仓库正在后台克隆，克隆完成后开始轮询；期间该仓库标记为“初始化中”。
                  </div>
                )}
                {status.initStatus === 'failed' && (
                  <div className="alert error" role="alert">
                    初始化失败：无法确定监控起点，请检查仓库地址与凭据后重新启用监控。
                  </div>
                )}
                {status.lastPollError && (
                  <div className="alert error" role="alert">
                    最近轮询失败：{status.lastPollError}
                  </div>
                )}
                <h3>最近触发 / 跳过记录</h3>
                {status.recentLog.length === 0 && <p className="muted">暂无记录。</p>}
                {status.recentLog.length > 0 && (
                  <div className="table-wrap">
                    <table className="table compact">
                      <caption className="visually-hidden">最近的监控触发与跳过记录</caption>
                      <thead>
                        <tr>
                          <th scope="col">节点</th>
                          <th scope="col">动作</th>
                          <th scope="col">作者</th>
                          <th scope="col">原因</th>
                          <th scope="col">时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {status.recentLog.map((log) => (
                          <tr key={log.id}>
                            <td className="mono">{log.node}</td>
                            <td>
                              <span className={log.action === 'triggered' ? 'tag ok' : 'tag off'}>
                                {log.action === 'triggered' ? '触发' : '跳过'}
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

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
