import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Provider, type Repo } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { usePermission } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n } from '../i18n';

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
  const { t, locale } = useI18n();
  usePageTitle(t('repos.pageTitle'));
  const canEdit = usePermission('repo:edit');
  const repos = useApi(() => api.get<Repo[]>('/api/repos'));
  const providers = useApi(() => api.get<Provider[]>('/api/providers'));
  const flash = useFlash();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

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
        flash.ok(t('repos.toast.created'));
      } else {
        await api.put(`/api/repos/${editingId}`, payload);
        flash.ok(t('repos.toast.updated'));
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
      flash.ok(repo.enabled ? t('repos.toast.disabled') : t('repos.toast.enabled'));
      await repos.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const retryInit = async (repo: Repo) => {
    setRetryingId(repo.id);
    try {
      await api.post(`/api/repos/${repo.id}/init`);
      flash.ok(t('repos.toast.initStarted', { name: repo.name }));
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
        title: t('repos.confirm.deleteTitle', { name: repo.name }),
        body: t('repos.confirm.deleteBody', {
          rules: impact.monitorRules,
          tasks: impact.tasks,
          reports: impact.reports,
        }),
        confirmLabel: t('repos.confirm.deleteButton'),
        danger: true,
      });
      if (!ok) return;
      await api.del(`/api/repos/${repo.id}`);
      flash.ok(t('repos.toast.deleted'));
      if (editingId === repo.id) startCreate();
      await repos.reload();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const defaultProviderInfo = defaultProvider
    ? locale === 'zh-CN'
      ? `（${defaultProvider.name} · ${defaultProvider.model}）`
      : ` (${defaultProvider.name} · ${defaultProvider.model})`
    : '';

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('repos.pageTitle')}</h1>
          <p className="page-subtitle">{t('repos.subtitle')}</p>
        </div>
        {canEdit && (
          <button type="button" className="secondary" onClick={startCreate}>
            {t('repos.addButton')}
          </button>
        )}
      </div>

      <div className={canEdit ? 'split' : 'stack'}>
        {canEdit && (
        <section className="card" aria-labelledby="repo-form-title">
          <h2 id="repo-form-title">
            {editingId === null ? t('repos.form.createTitle') : t('repos.form.editTitle')}
          </h2>
          <form className="form" onSubmit={save} aria-describedby={ids.hint}>
            <div className="two-col">
              <label htmlFor={ids.type}>
                {t('common.type')}
                <select
                  id={ids.type}
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as 'svn' | 'git' })}
                >
                  <option value="svn">SVN</option>
                  <option value="git">Git</option>
                </select>
              </label>
              <label htmlFor={ids.reviewConcurrency}>
                {t('repos.form.reviewConcurrency')}
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
            </div>
            <p className="muted small form-hint" id={ids.reviewConcurrencyHint}>
              {t('repos.form.reviewConcurrencyHint')}
            </p>
            <label htmlFor={ids.name}>
              {t('common.name')}
              <input
                id={ids.name}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('repos.form.namePlaceholder')}
                required
              />
            </label>
            <label htmlFor={ids.url}>
              {form.type === 'svn' ? t('repos.form.svnUrl') : t('repos.form.gitUrl')}
              <input
                id={ids.url}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={
                  form.type === 'svn'
                    ? t('repos.form.svnUrlPlaceholder')
                    : t('repos.form.gitUrlPlaceholder')
                }
                required
              />
            </label>
            {form.type === 'git' && (
              <label htmlFor={ids.branch}>
                {t('repos.form.branch')}
                <input
                  id={ids.branch}
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                />
              </label>
            )}
            <div className="two-col">
              <label htmlFor={ids.username}>
                {t('repos.form.username')}
                <input
                  id={ids.username}
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  autoComplete="off"
                />
              </label>
              <label htmlFor={ids.password}>
                {form.type === 'svn' ? t('repos.form.svnPassword') : t('repos.form.gitPassword')}
                <input
                  id={ids.password}
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={editingId === null ? '' : t('common.leaveBlankUnchanged')}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <fieldset className="provider-pool" aria-describedby={ids.providerHint}>
              <legend>{t('repos.form.providerLegend')}</legend>
              <p className="muted small" id={ids.providerHint}>
                {t('repos.form.providerHint', { defaultInfo: defaultProviderInfo })}
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
                      {order === 0 && <span className="tag">{t('repos.form.providerPreferred')}</span>}
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
                    {t('repos.form.providerDeleted', { id })}
                  </label>
                </div>
              ))}
            </fieldset>
            {providers.loading && (
              <p className="muted small" role="status">
                {t('repos.form.providerLoading')}
              </p>
            )}
            {providers.error && (
              <p className="muted small" role="alert">
                {t('repos.form.providerLoadError')}{' '}
                <button type="button" className="link" onClick={providers.reload}>
                  {t('common.retry')}
                </button>
              </p>
            )}
            {providers.data?.length === 0 && (
              <p className="muted small">
                {t('repos.form.providerEmptyPrefix')}
                <Link to="/providers">{t('nav.providers')}</Link>
                {t('repos.form.providerEmptySuffix')}
              </p>
            )}
            <label className="checkbox" htmlFor={ids.enabled}>
              <input
                id={ids.enabled}
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              {t('repos.form.enabled')}
            </label>
            {formError && (
              <div className="alert error" id={ids.error} role="alert">
                {formError}
              </div>
            )}
            <div className="actions">
              <button className="primary" type="submit" disabled={saving}>
                {saving ? t('repos.form.saving') : t('common.save')}
              </button>
              {editingId !== null && (
                <button type="button" className="secondary" onClick={startCreate}>
                  {t('common.cancelEdit')}
                </button>
              )}
            </div>
            <p className="muted small" id={ids.hint}>
              {t('repos.form.hint')}
            </p>
          </form>
        </section>
        )}

        <section className="card grow" aria-labelledby="repo-list-title">
          <h2 id="repo-list-title">{t('repos.list.title')}</h2>
          {repos.loading && <p className="muted">{t('common.loading')}</p>}
          {repos.error && (
            <div className="alert error" role="alert">
              {repos.error}
            </div>
          )}
          {repos.data && repos.data.length === 0 && <p className="muted">{t('repos.list.empty')}</p>}
          {repos.data && repos.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{t('repos.list.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('repos.list.colNameUrl')}</th>
                    <th scope="col">{t('common.type')}</th>
                    <th scope="col">{t('repos.list.colBranch')}</th>
                    <th scope="col">{t('repos.list.colCredential')}</th>
                    <th scope="col">{t('repos.list.colInit')}</th>
                    <th scope="col">{t('common.status')}</th>
                    <th scope="col" className="actions-cell">
                      {t('common.actions')}
                    </th>
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
                      <td className="nowrap">
                        {repo.hasCredential ? t('repos.list.configured') : '—'}
                      </td>
                      <td className="nowrap">
                        {repo.initStatus === 'preparing' || repo.initStatus === 'pending' ? (
                          <span className="tag preparing">
                            <span className="spinner" aria-hidden="true" />
                            {t('repos.list.downloading')}
                          </span>
                        ) : repo.initStatus === 'failed' ? (
                          canEdit ? (
                            <button
                              type="button"
                              className="tag failed init-retry"
                              title={repo.initError ?? t('repos.list.initFailed')}
                              onClick={() => retryInit(repo)}
                              disabled={retryingId === repo.id}
                            >
                              {retryingId === repo.id
                                ? t('common.retrying')
                                : t('repos.list.initFailedRetry')}
                            </button>
                          ) : (
                            <span className="tag failed" title={repo.initError ?? t('repos.list.initFailed')}>
                              {t('repos.list.initFailed')}
                            </span>
                          )
                        ) : (
                          <span className="tag succeeded">{t('repos.list.initReady')}</span>
                        )}
                      </td>
                      <td className="nowrap">
                        <span className={repo.enabled ? 'dot ok' : 'dot off'} />
                        {repo.enabled ? t('common.enabled') : t('common.disabled')}
                      </td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          {canEdit && (
                            <button type="button" className="link" onClick={() => startEdit(repo)}>
                              {t('common.edit')}
                              <span className="visually-hidden">
                                {t('repos.list.srRepo', { name: repo.name })}
                              </span>
                            </button>
                          )}
                          <Link to={`/repos/${repo.id}/memory`}>
                            {t('repos.list.memory')}
                            <span className="visually-hidden">
                              {t('repos.list.srRepo', { name: repo.name })}
                            </span>
                          </Link>
                          {canEdit && (
                            <>
                              <button type="button" className="link" onClick={() => toggle(repo)}>
                                {repo.enabled ? t('common.disable') : t('common.enable')}
                                <span className="visually-hidden">
                                  {t('repos.list.srRepo', { name: repo.name })}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => remove(repo)}
                              >
                                {t('common.delete')}
                                <span className="visually-hidden">
                                  {t('repos.list.srRepo', { name: repo.name })}
                                </span>
                              </button>
                            </>
                          )}
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
