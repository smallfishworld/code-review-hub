import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorText, usePageTitle } from '../api/hooks';

export function LoginPage() {
  usePageTitle('登录');
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { username: useId(), password: useId(), error: useId() };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate('/repos', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1 id="login-title">代码评审平台</h1>
            <p className="muted small">
              {status?.loginRequired
                ? '请输入管理员口令登录控制台'
                : '当前未设置管理员口令（首次使用请登录后设置）'}
            </p>
          </div>
        </div>
        <label htmlFor={ids.username}>
          用户名
          <input
            id={ids.username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label htmlFor={ids.password}>
          口令
          <input
            id={ids.password}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-describedby={error ? ids.error : undefined}
            aria-invalid={error ? true : undefined}
            autoFocus
          />
        </label>
        {error && (
          <div className="alert error" id={ids.error} role="alert">
            {error}
          </div>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
