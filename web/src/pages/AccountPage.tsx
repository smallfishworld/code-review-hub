import { useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Permission } from '../api/client';
import { errorText, usePageTitle } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { PasswordInput } from '../components/PasswordInput';
import { useFlash } from '../components/Toast';

const PERMISSION_LABELS: Record<Permission, string> = {
  'repo:edit': '仓库编辑',
  'monitor:edit': '监控规则编辑',
  'review:trigger': '手动触发评审',
  'feedback:write': '缺陷反馈与分享',
  'memory:edit': '项目记忆编辑',
  'provider:edit': 'AI 模型提供编辑',
  'engine:edit': '评审引擎修改',
  'mcp:edit': 'MCP 服务编辑',
  'notification:edit': '通知渠道编辑',
  'log:manage': '运行日志管理',
  'user:manage': '用户与权限管理',
};

function safeReturnPath(state: unknown): string {
  const raw = (state as { from?: unknown } | null)?.from;
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && raw !== '/account') {
    return raw;
  }
  return '/repos';
}

export function AccountPage() {
  const { status } = useAuth();
  const user = status?.user;
  return <AccountView key={`${user?.id ?? 'none'}:${user?.displayName ?? ''}:${user?.email ?? ''}`} />;
}

function AccountView() {
  usePageTitle('我的账号');
  const { status, refresh } = useAuth();
  const flash = useFlash();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state);
  const user = status?.user;
  const forcePassword = Boolean(user?.mustChangePassword);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [profileBusy, setProfileBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);

  const ids = {
    displayName: useId(),
    email: useId(),
    current: useId(),
    next: useId(),
    confirm: useId(),
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileBusy(true);
    try {
      await api.put('/api/me', { displayName: displayName.trim(), email: email.trim() || null });
      await refresh();
      flash.ok('个人资料已更新');
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      flash.fail('两次输入的新密码不一致');
      return;
    }
    setPwdBusy(true);
    try {
      await api.post('/api/me/password', {
        currentPassword,
        password: newPassword,
      });
      await refresh();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      flash.ok('密码已更新');
      if (forcePassword) {
        navigate(returnTo, { replace: true });
      }
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setPwdBusy(false);
    }
  };

  const perms = user?.permissions ?? [];

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>我的账号</h1>
          <p className="page-subtitle">查看当前角色与权限，管理个人资料与登录密码。</p>
        </div>
      </div>

      {forcePassword && (
        <div className="alert warn" role="alert">
          您的账号需要修改初始密码后才能继续使用控制台，请在下方完成密码修改。
        </div>
      )}

      <div className="split settings-split">
        <section className="card">
          <h2>账号信息</h2>
          <form className="form" onSubmit={saveProfile}>
            <div className="two-col">
              <div>
                <span className="small muted">用户名</span>
                <div className="mono">{user?.username ?? '—'}</div>
              </div>
              <div>
                <span className="small muted">角色</span>
                <div>
                  <span className={`tag ${user?.isSuperAdmin ? 'ok' : ''}`}>
                    {user?.isSuperAdmin ? '超级管理员' : (user?.roleName ?? '未分配')}
                  </span>
                </div>
              </div>
            </div>
            <div>
              <span className="small muted">当前权限</span>
              <div className="row-actions" style={{ marginTop: 6 }}>
                {user?.isSuperAdmin ? (
                  <span className="tag ok">全部权限</span>
                ) : perms.length === 0 ? (
                  <span className="small muted">仅只读查看</span>
                ) : (
                  perms.map((p) => (
                    <span key={p} className="tag category">
                      {PERMISSION_LABELS[p] ?? p}
                    </span>
                  ))
                )}
              </div>
            </div>
            <label htmlFor={ids.displayName}>
              显示名称
              <input
                id={ids.displayName}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
            <label htmlFor={ids.email}>
              邮箱
              <input
                id={ids.email}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </label>
            <div className="actions">
              <button type="submit" className="primary" disabled={profileBusy || !user || user.id === 0}>
                保存资料
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>修改密码</h2>
          <form className="form" onSubmit={changePassword}>
            <label htmlFor={ids.current}>
              当前密码
              <PasswordInput
                id={ids.current}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
                autoFocus={forcePassword}
              />
            </label>
            <label htmlFor={ids.next}>
              新密码（至少 8 位，需包含字母和数字）
              <PasswordInput
                id={ids.next}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </label>
            <label htmlFor={ids.confirm}>
              确认新密码
              <PasswordInput
                id={ids.confirm}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </label>
            <div className="actions">
              <button type="submit" className="primary" disabled={pwdBusy || !user || user.id === 0}>
                更新密码
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
