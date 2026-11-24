import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Repo, type Task, type TaskList } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { NodePicker } from '../components/NodePicker';
import { useFlash } from '../components/Toast';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export function TriggerPage() {
  usePageTitle('手动触发');
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
          flash.ok(`已创建评审任务 #${res.task.id}`);
          void recentTasks.reload();
        } catch (err) {
          const e2 = err as { status?: number; body?: { duplicate?: boolean } };
          if (e2.status === 409 && e2.body?.duplicate) {
            const ok = await confirm({
              title: '该节点已评审过',
              body: `节点 ${node.trim()} 已有评审记录，是否重新评审？`,
              confirmLabel: '重新评审',
            });
            if (!ok) return;
            const res = await api.post<{ task: Task }>(`/api/repos/${repoId}/review`, {
              node: node.trim(),
              force: true,
            });
            setResult([res.task]);
            flash.ok(`已创建重新评审任务 #${res.task.id}`);
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
          // Every node in the range already has a review: an "已创建 0 个"
          // success toast would look like a broken button.
          flash.fail(
            res.duplicates > 0
              ? `区间内 ${res.duplicates} 个节点均已评审过，未创建新任务`
              : '区间内没有可评审的节点'
          );
        } else if (res.duplicates > 0) {
          flash.ok(`已创建 ${res.tasks.length} 个评审任务，跳过 ${res.duplicates} 个已评审节点`);
          void recentTasks.reload();
        } else {
          flash.ok(`已创建 ${res.tasks.length} 个评审任务`);
          void recentTasks.reload();
        }
      }
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const placeholder = repo?.type === 'git' ? 'commit 哈希（可短哈希）' : 'revision 号';

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>手动触发评审</h1>
          <p className="page-subtitle">指定单个提交或版本区间立即发起 AI 代码审查</p>
        </div>
        <Link to="/tasks" className="btn-link secondary">
          全部任务列表
        </Link>
      </div>

      <div className="split">
        <section className="card" aria-labelledby="trigger-form-title">
          <h2 id="trigger-form-title">发起评审</h2>
          <form className="form" onSubmit={submit} aria-describedby={ids.hint}>
            <label htmlFor={ids.repo}>
              仓库
              <select
                id={ids.repo}
                value={repoId}
                onChange={(e) => setRepoId(e.target.value === '' ? '' : Number(e.target.value))}
                required
              >
                <option value="">请选择仓库</option>
                {repos.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}（{r.type.toUpperCase()}）
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="radio-row">
              <legend className="visually-hidden">评审范围</legend>
              <label className="radio" htmlFor={ids.single}>
                <input
                  id={ids.single}
                  type="radio"
                  name="trigger-mode"
                  checked={mode === 'single'}
                  onChange={() => setMode('single')}
                />
                单节点
              </label>
              <label className="radio" htmlFor={ids.range}>
                <input
                  id={ids.range}
                  type="radio"
                  name="trigger-mode"
                  checked={mode === 'range'}
                  onChange={() => setMode('range')}
                />
                区间
              </label>
            </fieldset>

            {mode === 'single' ? (
              <label htmlFor={ids.node}>
                节点
                <NodePicker
                  inputId={ids.node}
                  label="节点"
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
                  起始节点
                  <NodePicker
                    inputId={ids.from}
                    label="起始节点"
                    repoId={repoId}
                    value={from}
                    onChange={setFrom}
                    placeholder={placeholder}
                    required
                  />
                </label>
                <label htmlFor={ids.to}>
                  结束节点
                  <NodePicker
                    inputId={ids.to}
                    label="结束节点"
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
                {busy ? '提交中…' : '开始评审'}
              </button>
            </div>
            <p className="muted small" id={ids.hint}>
              区间模式会为区间内每个节点创建独立任务（按时间顺序），大区间会提示确认。
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
              <h2 id="created-tasks-title">已创建任务</h2>
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">本次触发创建的任务</caption>
                  <thead>
                    <tr>
                      <th scope="col">任务</th>
                      <th scope="col">节点</th>
                      <th scope="col">状态</th>
                      <th scope="col" className="actions-cell">
                        操作
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
                            {STATUS_LABEL[task.status] ?? task.status}
                          </span>
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="link"
                            onClick={() => navigate(`/tasks/${task.id}`)}
                          >
                            查看进度<span className="visually-hidden">任务 #{task.id}</span>
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
              <h2 id="recent-manual-title">最近手动触发记录</h2>
              <button
                type="button"
                className="secondary small"
                onClick={() => void recentTasks.reload()}
              >
                刷新
              </button>
            </div>
            {recentTasks.loading && !recentTasks.data && <p className="muted">加载中…</p>}
            {recentTasks.data && recentTasks.data.items.length === 0 && (
              <p className="muted">暂无手动触发记录。在左侧选择仓库与提交节点即可发起评审。</p>
            )}
            {recentTasks.data && recentTasks.data.items.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">最近手动触发的评审任务</caption>
                  <thead>
                    <tr>
                      <th scope="col">任务</th>
                      <th scope="col">仓库</th>
                      <th scope="col">节点</th>
                      <th scope="col">状态</th>
                      <th scope="col">触发时间</th>
                      <th scope="col" className="actions-cell">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTasks.data.items.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <Link to={`/tasks/${task.id}`}>#{task.id}</Link>
                        </td>
                        <td>{repos.data?.find((r) => r.id === task.repoId)?.name ?? `#${task.repoId}`}</td>
                        <td className="mono" title={task.node}>
                          {shortHash(task.node)}
                        </td>
                        <td>
                          <span className={`tag ${task.status}`}>
                            {STATUS_LABEL[task.status] ?? task.status}
                          </span>
                        </td>
                        <td className="small muted">{formatTime(task.createdAt)}</td>
                        <td className="actions-cell">
                          <Link to={`/tasks/${task.id}`}>
                            查看进度<span className="visually-hidden">任务 #{task.id}</span>
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

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
