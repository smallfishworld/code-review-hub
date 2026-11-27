import { useId, useState } from 'react';
import { api, type AuthStatus, type DepInfo } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useFlash } from '../components/Toast';
import { useI18n } from '../i18n';

/** Settings: dependency status + admin password. */
export function SettingsPage() {
  const { t } = useI18n();
  usePageTitle(t('settings.pageTitle'));
  const deps = useApi(() => api.get<{ results: DepInfo[]; ok: boolean }>('/api/deps'));
  const auth = useApi(() => api.get<AuthStatus>('/api/auth/status'));
  const flash = useFlash();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const ids = {
    current: useId(),
    next: useId(),
    hint: useId(),
  };

  // Re-probe the external commands (the report is captured at startup, so a
  // freshly installed svn/git would otherwise stay unavailable until a restart).
  const recheckDeps = async () => {
    setChecking(true);
    try {
      const res = await api.post<{ results: DepInfo[]; ok: boolean }>('/api/deps/check');
      deps.setData(res);
      flash.ok(res.ok ? t('settings.deps.toastOk') : t('settings.deps.toastFail'));
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/password', {
        password: next,
        currentPassword: current || undefined,
      });
      flash.ok(t('settings.password.toastUpdated'));
      setCurrent('');
      setNext('');
      await auth.reload();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>{t('settings.pageTitle')}</h1>
          <p className="page-subtitle">{t('settings.subtitle')}</p>
        </div>
      </div>

      <div className="split settings-split">
        <section className="card" aria-labelledby="deps-title">
          <div className="card-head">
            <h2 id="deps-title">{t('settings.deps.title')}</h2>
            <button
              type="button"
              className="secondary small"
              onClick={() => void recheckDeps()}
              disabled={checking}
            >
              {checking ? t('settings.deps.checking') : t('settings.deps.recheck')}
            </button>
          </div>
          {deps.loading && <p className="muted">{t('settings.deps.checking')}</p>}
          {deps.error && (
            <div className="alert error" role="alert">
              {deps.error}
            </div>
          )}
          {deps.data && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{t('settings.deps.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.deps.colCommand')}</th>
                    <th scope="col">{t('common.status')}</th>
                    <th scope="col">{t('settings.deps.colVersion')}</th>
                    <th scope="col">{t('settings.deps.colNote')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deps.data.results.map((dep) => (
                    <tr key={dep.command}>
                      <td className="mono">{dep.command}</td>
                      <td>
                        <span className={dep.found && dep.executable ? 'tag ok' : 'tag failed'}>
                          {dep.found && dep.executable
                            ? t('settings.deps.available')
                            : t('settings.deps.unavailable')}
                        </span>
                      </td>
                      <td className="small">{dep.version ?? '—'}</td>
                      <td className="small">
                        {dep.conditional ? t('settings.deps.conditional') : t('settings.deps.required')}
                        {dep.minVersion ? t('settings.deps.minVersion', { version: dep.minVersion }) : ''}
                        {dep.note ? `: ${dep.note}` : ''}
                        {dep.error ? `: ${dep.error}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="password-title">
          <h2 id="password-title">{t('settings.password.title')}</h2>
          <form className="form" onSubmit={changePassword} aria-describedby={ids.hint}>
            {auth.data?.loginRequired && (
              <label htmlFor={ids.current}>
                {t('settings.password.current')}
                <input
                  id={ids.current}
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
            )}
            <label htmlFor={ids.next}>
              {t('settings.password.next')}
              <input
                id={ids.next}
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                minLength={6}
                required
                autoComplete="new-password"
              />
            </label>
            <p className="muted small" id={ids.hint}>
              {t('settings.password.hint')}
            </p>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {t('settings.password.submit')}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
