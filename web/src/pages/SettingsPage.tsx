import { useId, useState } from 'react';
import { api, type AuthStatus, type DepInfo } from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useFlash } from '../components/Toast';

/** Settings: dependency status + admin password. */
export function SettingsPage() {
  usePageTitle('系统设置');
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
  // freshly installed svn/git would otherwise stay "不可用" until a restart).
  const recheckDeps = async () => {
    setChecking(true);
    try {
      const res = await api.post<{ results: DepInfo[]; ok: boolean }>('/api/deps/check');
      deps.setData(res);
      flash.ok(res.ok ? '依赖检测通过' : '依赖检测完成，存在不可用项');
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
      flash.ok('管理员口令已更新');
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
          <h1>系统设置</h1>
          <p className="page-subtitle">检查外部命令行运行依赖环境并维护管理员安全口令</p>
        </div>
      </div>

      <div className="split settings-split">
        <section className="card" aria-labelledby="deps-title">
          <div className="card-head">
            <h2 id="deps-title">依赖状态</h2>
            <button
              type="button"
              className="secondary small"
              onClick={() => void recheckDeps()}
              disabled={checking}
            >
              {checking ? '检测中…' : '重新检测'}
            </button>
          </div>
          {deps.loading && <p className="muted">检测中…</p>}
          {deps.error && (
            <div className="alert error" role="alert">
              {deps.error}
            </div>
          )}
          {deps.data && (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">外部命令依赖检测结果</caption>
                <thead>
                  <tr>
                    <th scope="col">命令</th>
                    <th scope="col">状态</th>
                    <th scope="col">版本</th>
                    <th scope="col">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {deps.data.results.map((dep) => (
                    <tr key={dep.command}>
                      <td className="mono">{dep.command}</td>
                      <td>
                        <span className={dep.found && dep.executable ? 'tag ok' : 'tag failed'}>
                          {dep.found && dep.executable ? '可用' : '不可用'}
                        </span>
                      </td>
                      <td className="small">{dep.version ?? '—'}</td>
                      <td className="small">
                        {dep.conditional ? '按仓库类型条件需要' : '必需'}
                        {dep.minVersion ? `，要求 ≥ ${dep.minVersion}` : ''}
                        {dep.note ? `：${dep.note}` : ''}
                        {dep.error ? `：${dep.error}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="password-title">
          <h2 id="password-title">管理员口令</h2>
          <form className="form" onSubmit={changePassword} aria-describedby={ids.hint}>
            {auth.data?.loginRequired && (
              <label htmlFor={ids.current}>
                当前口令
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
              新口令
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
              至少 6 位。当前版本仅支持管理员口令登录，统一登录（OA / LDAP）为预留扩展点。
            </p>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                更新口令
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
