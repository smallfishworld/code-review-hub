import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorText, usePageTitle } from '../api/hooks';
import { PasswordInput } from '../components/PasswordInput';
import { LanguageSwitcher, useI18n } from '../i18n';

function safeReturnPath(state: unknown): string {
  const raw = (state as { from?: unknown } | null)?.from;
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && raw !== '/login') {
    return raw;
  }
  return '/repos';
}

export function LoginPage() {
  const { t } = useI18n();
  usePageTitle(t('login.pageTitle'));
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { username: useId(), password: useId(), error: useId() };

  useEffect(() => {
    if (status?.authenticated) {
      if (status.user?.mustChangePassword) {
        navigate('/account', { replace: true, state: { from: returnTo } });
      } else {
        navigate(returnTo, { replace: true });
      }
    }
  }, [status, navigate, returnTo]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username.trim(), password);
      if (user.mustChangePassword) {
        navigate('/account', { replace: true, state: { from: returnTo } });
      } else {
        navigate(returnTo, { replace: true });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <LanguageSwitcher className="login-lang" />
      <form className="card login-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <img className="brand-mark" src="/logo.png" alt="" aria-hidden="true" width={44} height={44} />
          <div>
            <h1 id="login-title">{t('app.name')}</h1>
            <p className="muted small">{t('login.promptRequired')}</p>
          </div>
        </div>
        <label htmlFor={ids.username}>
          {t('login.username')}
          <input
            id={ids.username}
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </label>
        <label htmlFor={ids.password}>
          {t('login.password')}
          <PasswordInput
            id={ids.password}
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-describedby={error ? ids.error : undefined}
            aria-invalid={error ? true : undefined}
            required
          />
        </label>
        {error && (
          <div className="alert error" id={ids.error} role="alert">
            {error}
          </div>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
        {status?.registrationEnabled && (
          <div className="login-footer-link">
            <Link to="/register">{t('login.registerLink')}</Link>
          </div>
        )}
      </form>
    </div>
  );
}
