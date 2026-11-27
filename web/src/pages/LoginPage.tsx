import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorText, usePageTitle } from '../api/hooks';
import { LanguageSwitcher, useI18n } from '../i18n';

export function LoginPage() {
  const { t } = useI18n();
  usePageTitle(t('login.pageTitle'));
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
      <LanguageSwitcher className="login-lang" />
      <form className="card login-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <img className="brand-mark" src="/logo.png" alt="" aria-hidden="true" width={44} height={44} />
          <div>
            <h1 id="login-title">{t('app.name')}</h1>
            <p className="muted small">
              {status?.loginRequired ? t('login.promptRequired') : t('login.promptInitial')}
            </p>
          </div>
        </div>
        <label htmlFor={ids.username}>
          {t('login.username')}
          <input
            id={ids.username}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label htmlFor={ids.password}>
          {t('login.password')}
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
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
