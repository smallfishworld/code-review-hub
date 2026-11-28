import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { errorText, usePageTitle } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { PasswordInput } from '../components/PasswordInput';
import { LanguageSwitcher, useI18n } from '../i18n';

export function RegisterPage() {
  const { t } = useI18n();
  usePageTitle('申请账号');
  const { status } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [reason, setReason] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = {
    username: useId(),
    displayName: useId(),
    email: useId(),
    password: useId(),
    confirm: useId(),
    reason: useId(),
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/register', {
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        password,
        reason: reason.trim(),
        website,
      });
      setSubmitted(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <LanguageSwitcher className="login-lang" />
      <div className="card login-card">
        <div className="login-brand">
          <img className="brand-mark" src="/logo.png" alt="" aria-hidden="true" width={44} height={44} />
          <div>
            <h1>{t('app.name')}</h1>
            <p className="muted small">提交账号注册申请，管理员审批通过后即可登录</p>
          </div>
        </div>

        {status && !status.registrationEnabled ? (
          <>
            <div className="alert warn">系统当前已关闭自助注册申请，请联系管理员为您创建账号。</div>
            <Link to="/login" className="btn-link secondary">
              返回登录
            </Link>
          </>
        ) : submitted ? (
          <>
            <div className="alert ok">
              注册申请已提交并通知管理员。审批通过后，您可以使用刚才设置的用户名和密码直接登录。
            </div>
            <Link to="/login" className="btn-link primary">
              返回登录
            </Link>
          </>
        ) : (
          <form className="form" onSubmit={submit}>
            <label htmlFor={ids.username}>
              用户名（3–32 位字母、数字、点、下划线或连字符）
              <input
                id={ids.username}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                autoFocus
              />
            </label>
            <label htmlFor={ids.displayName}>
              姓名 / 显示名称
              <input
                id={ids.displayName}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
            <label htmlFor={ids.email}>
              邮箱（可选）
              <input
                id={ids.email}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </label>
            <label htmlFor={ids.password}>
              登录密码（至少 8 位，需包含字母和数字）
              <PasswordInput
                id={ids.password}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </label>
            <label htmlFor={ids.confirm}>
              确认密码
              <PasswordInput
                id={ids.confirm}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </label>
            <label htmlFor={ids.reason}>
              申请理由 / 所属团队（可选）
              <textarea
                id={ids.reason}
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：XX 项目开发，需查看评审报告并触发评审"
              />
            </label>
            <div className="visually-hidden" aria-hidden="true">
              <input
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? '提交中…' : '提交注册申请'}
            </button>
            <div className="login-footer-link">
              <Link to="/login">已有账号？返回登录</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
