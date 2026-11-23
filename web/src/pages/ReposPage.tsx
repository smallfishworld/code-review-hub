import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Provider, type Repo } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';

interface FormState {
  type: 'svn' | 'git';
  name: string;
  url: string;
  username: string;
  password: string;
  branch: string;
  reviewConcurrency: string;
  /** Ordered model pool; empty = inherit the global default. */
  providerIds: number[];
  enabled: boolean;
}

const DEFAULT_REVIEW_CONCURRENCY = 2;

const emptyForm: FormState = {
  type: 'svn',
  name: '',
  url: '',
  username: '',
  password: '',
  branch: 'main',
  reviewConcurrency: String(DEFAULT_REVIEW_CONCURRENCY),
  providerIds: [],
  enabled: true,
};

export function ReposPage() {
  usePageTitle('仓库管理');
  const repos = useApi(() => api.get<Repo[]>('/api/repos'));
  const providers = useApi(() => api.get<Provider[]>('/api/providers'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  // While any repo is pending/preparing (or failed and being retried), poll
  // the list so the 初始化 column moves to 完成 without a manual reload.
  const hasPending = repos.data?.some(
    (r) => r.initStatus === 'pending' || r.initStatus === 'preparing'
  );
  const reload = repos.reload;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [hasPending, reload]);
  const ids = {
    type: useId(),
    name: useId(),
    url: useId(),
    username: useId(),
    password: useId(),
    branch: useId(),
    reviewConcurrency: useId(),
    reviewConcurrencyHint: useId(),
    provider: useId(),
    providerHint: useId(),
    enabled: useId(),
    hint: useId(),
    error: useId(),
  };
  const defaultProvider = providers.data?.find((provider) => provider.isDefault) ?? providers.data?.[0];
  // Pool members whose provider row disappeared (deleted meanwhile) are kept
  // visible so the operator can see and remove them. While the list is still
  // loading everything would look "missing", so wait for it.
  const unavailableProviderIds =
    providers.data === null
      ? []
      : form.providerIds.filter((id) => !providers.data!.some((provider) => provider.id === id));

  const startCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setFormError(null);
  };

  const startEdit = (repo: Repo) => {
    setEditingId(repo.id);
    setForm({
      type: repo.type,
      name: repo.name,
      url: repo.url,
      username: repo.username ?? '',
      password: '',
      branch: repo.branch ?? 'main',
      reviewConcurrency: String(repo.reviewConcurrency ?? DEFAULT_REVIEW_CONCURRENCY),
      providerIds: repo.providerIds ?? [],
      enabled: repo.enabled,
    });
    setFormError(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const payload = {
      type: form.type,
      name: form.name.trim(),
      url: form.url.trim(),
      username: form.username.trim() || undefined,
      password: form.password || undefined,
      branch: form.type === 'git' ? form.branch.trim() || 'main' : undefined,
      reviewConcurrency: Number(form.reviewConcurrency),
      providerIds: form.providerIds,
      enabled: form.enabled,
    };
    try {
      if (editingId === null) {
        await api.post('/api/repos', payload);
        flash.ok('仓库已保存，正在后台下载仓库代码…');
      } else {
        await api.put(`/api/repos/${editingId}`, payload);
        flash.ok('仓库已更新，正在后台检查仓库代码…');
      }
      setForm(emptyForm);
      setEditingId(null);
      await repos.reload();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (repo: Repo) => {
    try {
      await api.put(`/api/repos/${repo.id}`, {
        type: repo.type,
        name: repo.name,
        url: repo.url,
        username: repo.username,
        branch: repo.branch,
        enabled: !repo.enabled,
      });
      flash.ok(repo.enabled ? '仓库已停用' : '仓库已启用');
      await repos.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const retryInit = async (repo: Repo) => {
    setRetryingId(repo.id);
    try {
      await api.post(`/api/repos/${repo.id}/init`);
      flash.ok(`仓库「${repo.name}」开始初始化`);
      await repos.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setRetryingId(null);
    }
  };

  const remove = async (repo: Repo) => {
    try {
      const impact = await api.get<{ monitorRules: number; tasks: number; reports: number }>(
        `/api/repos/${repo.id}/impact`
      );
      const ok = await confirm({
        title: `删除仓库「${repo.name}」？`,
        body:
          `影响范围：\n` +
          `· 监控规则 ${impact.monitorRules} 条（将停止监控）\n` +
          `· 历史任务 ${impact.tasks} 个、报告 ${impact.reports} 份（将保留）`,
        confirmLabel: '删除仓库',
        danger: true,
      });
      if (!ok) return;
      await api.del(`/api/repos/${repo.id}`);
      flash.ok('仓库已删除，历史报告已保留');
      if (editingId === repo.id) startCreate();
      await repos.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>仓库管理</h1>
        <button type="button" className="secondary" onClick={startCreate}>
          新增仓库
        </button>
      </div>

      <div className="split">
        <section className="card" aria-labelledby="repo-form-title">
          <h2 id="repo-form-title">{editingId === null ? '新增仓库' : '编辑仓库'}</h2>
          <form className="form" onSubmit={save} aria-describedby={ids.hint}>
            <label htmlFor={ids.type}>
              类型
              <select
                id={ids.type}
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as 'svn' | 'git' })}
              >
                <option value="svn">SVN</option>
                <option value="git">Git</option>
              </select>
            </label>
            <label htmlFor={ids.name}>
              名称
              <input
                id={ids.name}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：核心交易系统"
                required
              />
            </label>
            <label htmlFor={ids.url}>
              {form.type === 'svn' ? '仓库 URL' : '远端 URL'}
              <input
                id={ids.url}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={
                  form.type === 'svn' ? 'svn://host/repo 或 https://host/svn/repo' : 'https://git.example.com/team/repo.git'
                }
                required
              />
            </label>
            <label htmlFor={ids.username}>
              用户名（可选）
              <input
                id={ids.username}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                autoComplete="off"
              />
            </label>
            <label htmlFor={ids.password}>
              {form.type === 'svn' ? '密码' : '密码 / 访问令牌'}
              <input
                id={ids.password}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={editingId === null ? '' : '留空表示不修改'}
                autoComplete="new-password"
              />
            </label>
            {form.type === 'git' && (
              <label htmlFor={ids.branch}>
                监控分支
                <input
                  id={ids.branch}
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                />
              </label>
            )}
            <label htmlFor={ids.reviewConcurrency}>
              评审并发数（必填）
              <input
                id={ids.reviewConcurrency}
                name="reviewConcurrency"
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                required
                aria-describedby={ids.reviewConcurrencyHint}
                value={form.reviewConcurrency}
                onChange={(e) => setForm({ ...form, reviewConcurrency: e.target.value })}
              />
            </label>
            <p className="muted small" id={ids.reviewConcurrencyHint}>
              同一仓库同时运行的评审任务数。设为 1 时串行，实际并发还受实例上限约束。
            </p>
            <fieldset className="provider-pool" aria-describedby={ids.providerHint}>
              <legend>评审模型（可多选）</legend>
              <p className="muted small" id={ids.providerHint}>
                并发评审时按当前负载在所选模型间分配；列表第一项为首选模型。
                不选则继承全局默认{defaultProvider ? `（${defaultProvider.name} · ${defaultProvider.model}）` : ''}。
              </p>
              {providers.data?.map((provider) => {
                const order = form.providerIds.indexOf(provider.id);
                const checked = order >= 0;
                return (
                  <div key={provider.id} className="provider-pool-row">
                    <label className="checkbox" htmlFor={`${ids.provider}-${provider.id}`}>
                      <input
                        id={`${ids.provider}-${provider.id}`}
                        type="checkbox"
                        checked={checked}
                        disabled={providers.loading}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            providerIds: e.target.checked
                              ? [...form.providerIds, provider.id]
                              : form.providerIds.filter((id) => id !== provider.id),
                          })
                        }
                      />
                      {provider.name} · {provider.model}
                      {order === 0 && <span className="tag">首选</span>}
                    </label>
                  </div>
                );
              })}
              {unavailableProviderIds.map((id) => (
                <div key={id} className="provider-pool-row">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        setForm({ ...form, providerIds: form.providerIds.filter((x) => x !== id) })
                      }
                    />
                    Provider #{id}（已删除）
                  </label>
                </div>
              ))}
            </fieldset>
            {providers.loading && <p className="muted small" role="status">正在加载模型列表…</p>}
            {providers.error && (
              <p className="muted small" role="alert">
                模型列表加载失败。<button type="button" className="link" onClick={providers.reload}>重试</button>
              </p>
            )}
            {providers.data?.length === 0 && (
              <p className="muted small">可在 <Link to="/providers">LLM Provider</Link> 中添加模型。</p>
            )}
            <label className="checkbox" htmlFor={ids.enabled}>
              <input
                id={ids.enabled}
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              启用该仓库
            </label>
            {formError && (
              <div className="alert error" id={ids.error} role="alert">
                {formError}
              </div>
            )}
            <div className="actions">
              <button className="primary" type="submit" disabled={saving}>
                {saving ? '验证并保存中…' : '保存'}
              </button>
              {editingId !== null && (
                <button type="button" className="secondary" onClick={startCreate}>
                  取消编辑
                </button>
              )}
            </div>
            <p className="muted small" id={ids.hint}>
              保存前会验证仓库连通性（SVN 使用 svn info，Git 使用 git ls-remote），验证失败不会保存。
            </p>
          </form>
        </section>

        <section className="card grow" aria-labelledby="repo-list-title">
          <h2 id="repo-list-title">仓库列表</h2>
          {repos.loading && <p className="muted">加载中…</p>}
          {repos.error && (
            <div className="alert error" role="alert">
              {repos.error}
            </div>
          )}
          {repos.data && repos.data.length === 0 && <p className="muted">暂无仓库，请先新增。</p>}
          {repos.data && repos.data.length > 0 && (
            <div className="table-wrap">
              <table className="table compact">
                <caption className="visually-hidden">已配置的仓库</caption>
                <thead>
                  <tr>
                    <th scope="col">名称 / 地址</th>
                    <th scope="col">类型</th>
                    <th scope="col">分支</th>
                    <th scope="col">凭据</th>
                    <th scope="col">初始化</th>
                    <th scope="col">状态</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {repos.data.map((repo) => (
                    <tr key={repo.id}>
                      <td>
                        <span className="cell-title">{repo.name}</span>
                        <span className="cell-sub mono" title={repo.url}>
                          {repo.url}
                        </span>
                      </td>
                      <td>
                        <span className={`tag ${repo.type}`}>{repo.type.toUpperCase()}</span>
                      </td>
                      <td className="nowrap">{repo.type === 'git' ? repo.branch : '—'}</td>
                      <td className="nowrap">{repo.hasCredential ? '已配置' : '—'}</td>
                      <td className="nowrap">
                        {repo.initStatus === 'preparing' || repo.initStatus === 'pending' ? (
                          <span className="tag preparing">
                            <span className="spinner" aria-hidden="true" />
                            下载中…
                          </span>
                        ) : repo.initStatus === 'failed' ? (
                          <button
                            type="button"
                            className="tag failed init-retry"
                            title={repo.initError ?? '初始化失败'}
                            onClick={() => retryInit(repo)}
                            disabled={retryingId === repo.id}
                          >
                            {retryingId === repo.id ? '重试中…' : '失败，点击重试'}
                          </button>
                        ) : (
                          <span className="tag succeeded">完成</span>
                        )}
                      </td>
                      <td className="nowrap">
                        <span className={repo.enabled ? 'dot ok' : 'dot off'} />
                        {repo.enabled ? '启用' : '停用'}
                      </td>
                      <td className="nowrap">
                        <div className="row-actions">
                          <button type="button" className="link" onClick={() => startEdit(repo)}>
                            编辑<span className="visually-hidden">仓库 {repo.name}</span>
                          </button>
                          <Link to={`/repos/${repo.id}/memory`}>
                            项目记忆<span className="visually-hidden">仓库 {repo.name}</span>
                          </Link>
                          <button type="button" className="link" onClick={() => toggle(repo)}>
                            {repo.enabled ? '停用' : '启用'}
                            <span className="visually-hidden">仓库 {repo.name}</span>
                          </button>
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => remove(repo)}
                          >
                            删除<span className="visually-hidden">仓库 {repo.name}</span>
                          </button>
                        </div>
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
  );
}
