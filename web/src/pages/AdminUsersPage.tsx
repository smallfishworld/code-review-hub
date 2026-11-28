import { useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  type AuditLogDto,
  type Permission,
  type PermissionMeta,
  type RegistrationDto,
  type RoleDto,
  type UserDto,
} from '../api/client';
import { errorText, useApi, usePageTitle } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useFlash } from '../components/Toast';
import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';

type AdminTab = 'users' | 'roles' | 'registrations' | 'audit';

function generateRandomPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  const chars = [
    letters[arr[0] % letters.length],
    digits[arr[1] % digits.length],
    ...Array.from(arr.slice(2), (v) => all[v % all.length]),
  ];
  return chars.join('');
}

export function AdminUsersPage() {
  usePageTitle('用户与权限');
  const { formatTime } = useI18n();
  const { status, refresh: refreshAuth } = useAuth();
  const flash = useFlash();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get('tab');
  const tab: AdminTab =
    rawTab === 'roles' || rawTab === 'registrations' || rawTab === 'audit' ? rawTab : 'users';
  const setTab = (next: AdminTab) => setSearchParams(next === 'users' ? {} : { tab: next });

  const isSuperAdmin = Boolean(status?.user?.isSuperAdmin);
  const myId = status?.user?.id ?? -1;
  const myPerms = status?.user?.permissions ?? [];

  const users = useApi(() => api.get<UserDto[]>('/api/admin/users'));
  const roles = useApi(() => api.get<RoleDto[]>('/api/admin/roles'));
  const permissions = useApi(() => api.get<PermissionMeta[]>('/api/admin/permissions'));
  const registrations = useApi(() => api.get<RegistrationDto[]>('/api/admin/registrations?status=all'));
  const regSetting = useApi(() => api.get<{ enabled: boolean }>('/api/admin/settings/registration'));
  const auditLogs = useApi(() => api.get<AuditLogDto[]>('/api/admin/audit-logs?limit=150'));

  const reloadAll = async () => {
    await Promise.all([
      users.reload(),
      roles.reload(),
      registrations.reload(),
      regSetting.reload(),
      auditLogs.reload(),
      refreshAuth(),
    ]);
  };

  // --- Create User form ---
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRoleId, setNewRoleId] = useState<string>('');
  const [newIsSuper, setNewIsSuper] = useState(false);
  const [userBusy, setUserBusy] = useState(false);

  // --- Edit / Reset password inline state ---
  const [editingUser, setEditingUser] = useState<UserDto | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRoleId, setEditRoleId] = useState<string>('');
  const [editIsSuper, setEditIsSuper] = useState(false);

  const [resetUser, setResetUser] = useState<UserDto | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [issuedCredential, setIssuedCredential] = useState<{
    username: string;
    password: string;
    action: 'created' | 'reset';
  } | null>(null);
  const userFormRef = useRef<HTMLElement>(null);

  const scrollToUserForm = () => {
    requestAnimationFrame(() => {
      userFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const copyWithFeedback = async (text: string, label: string) => {
    const ok = await copyText(text);
    if (ok) flash.ok(label);
    else flash.fail('复制失败，请手动选中复制');
  };

  // --- Role form ---
  const [editingRoleId, setEditingRoleId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');
  const [rolePerms, setRolePerms] = useState<Permission[]>([]);
  const [roleBusy, setRoleBusy] = useState(false);

  // --- Registration approval state ---
  const [approveRoleByReq, setApproveRoleByReq] = useState<Record<number, string>>({});
  const [approveSuperByReq, setApproveSuperByReq] = useState<Record<number, boolean>>({});
  const [rejectingReqId, setRejectingReqId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [regBusy, setRegBusy] = useState(false);

  const ids = {
    username: useId(),
    displayName: useId(),
    email: useId(),
    password: useId(),
    role: useId(),
    roleName: useId(),
    roleDesc: useId(),
  };

  const assignableRoles = (roles.data ?? []).filter((r) => r.name !== '超级管理员');
  const defaultDevRoleId =
    assignableRoles.find((r) => r.name === '开发人员')?.id ?? assignableRoles[0]?.id ?? '';
  const pendingCount = (registrations.data ?? []).filter((r) => r.status === 'pending').length;

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserBusy(true);
    try {
      const createdUsername = newUsername.trim();
      const createdPassword = newPassword;
      const roleId = newIsSuper ? null : Number(newRoleId || defaultDevRoleId);
      await api.post('/api/admin/users', {
        username: createdUsername,
        displayName: newDisplayName.trim() || undefined,
        email: newEmail.trim() || null,
        password: createdPassword,
        roleId,
        isSuperAdmin: newIsSuper,
      });
      setIssuedCredential({ username: createdUsername, password: createdPassword, action: 'created' });
      flash.ok(`已创建账号「${createdUsername}」`);
      setNewUsername('');
      setNewDisplayName('');
      setNewEmail('');
      setNewPassword('');
      setNewIsSuper(false);
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setUserBusy(false);
    }
  };

  const startEditUser = (u: UserDto) => {
    setResetUser(null);
    setEditingUser(u);
    setEditDisplayName(u.displayName);
    setEditEmail(u.email ?? '');
    const isAssignable = assignableRoles.some((r) => r.id === u.roleId);
    setEditRoleId(isAssignable ? String(u.roleId) : String(defaultDevRoleId));
    setEditIsSuper(u.isSuperAdmin);
    scrollToUserForm();
  };

  const saveEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setUserBusy(true);
    try {
      await api.put(`/api/admin/users/${editingUser.id}`, {
        displayName: editDisplayName.trim(),
        email: editEmail.trim() || null,
        roleId: editIsSuper ? null : Number(editRoleId || defaultDevRoleId),
        isSuperAdmin: isSuperAdmin ? editIsSuper : undefined,
      });
      flash.ok(`已更新账号「${editingUser.username}」`);
      setEditingUser(null);
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setUserBusy(false);
    }
  };

  const toggleUserStatus = async (u: UserDto) => {
    const nextStatus = u.status === 'active' ? 'disabled' : 'active';
    const ok = await confirm({
      title: nextStatus === 'disabled' ? `禁用账号「${u.username}」？` : `重新启用账号「${u.username}」？`,
      body:
        nextStatus === 'disabled'
          ? '禁用后该用户将被立即踢下线且无法登录，历史审计记录会保留。'
          : '启用后该用户可恢复正常登录。',
      confirmLabel: nextStatus === 'disabled' ? '确认禁用' : '确认启用',
      danger: nextStatus === 'disabled',
    });
    if (!ok) return;
    try {
      await api.put(`/api/admin/users/${u.id}`, { status: nextStatus });
      flash.ok(nextStatus === 'disabled' ? `已禁用「${u.username}」` : `已启用「${u.username}」`);
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const submitResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetUser) return;
    setUserBusy(true);
    try {
      const targetUsername = resetUser.username;
      const issuedPwd = resetPwd;
      await api.post(`/api/admin/users/${resetUser.id}/reset-password`, { password: issuedPwd });
      setIssuedCredential({ username: targetUsername, password: issuedPwd, action: 'reset' });
      flash.ok(`已重置「${targetUsername}」的密码，下次登录需修改`);
      setResetUser(null);
      setResetPwd('');
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setUserBusy(false);
    }
  };

  const startEditRole = (r: RoleDto) => {
    setEditingRoleId(r.id);
    setRoleName(r.name);
    setRoleDesc(r.description);
    setRolePerms([...r.permissions]);
  };

  const resetRoleForm = () => {
    setEditingRoleId(null);
    setRoleName('');
    setRoleDesc('');
    setRolePerms([]);
  };

  const toggleRolePerm = (perm: Permission) => {
    setRolePerms((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]));
  };

  const saveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    setRoleBusy(true);
    try {
      if (editingRoleId) {
        await api.put(`/api/admin/roles/${editingRoleId}`, {
          name: roleName.trim(),
          description: roleDesc.trim(),
          permissions: rolePerms,
        });
        flash.ok(`已更新角色「${roleName.trim()}」`);
      } else {
        await api.post('/api/admin/roles', {
          name: roleName.trim(),
          description: roleDesc.trim(),
          permissions: rolePerms,
        });
        flash.ok(`已创建角色「${roleName.trim()}」`);
      }
      resetRoleForm();
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setRoleBusy(false);
    }
  };

  const deleteRole = async (r: RoleDto) => {
    const ok = await confirm({
      title: `删除自定义角色「${r.name}」？`,
      body: '删除后不可恢复。',
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/admin/roles/${r.id}`);
      flash.ok(`已删除角色「${r.name}」`);
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const toggleRegistrationEnabled = async () => {
    if (!regSetting.data) return;
    try {
      const next = !regSetting.data.enabled;
      await api.put('/api/admin/settings/registration', { enabled: next });
      flash.ok(next ? '已开启自助注册申请' : '已关闭自助注册申请');
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    }
  };

  const approveRegistration = async (req: RegistrationDto) => {
    setRegBusy(true);
    try {
      const makeSuper = Boolean(approveSuperByReq[req.id]);
      const roleId = makeSuper ? null : Number(approveRoleByReq[req.id] || defaultDevRoleId);
      await api.post(`/api/admin/registrations/${req.id}/approve`, {
        roleId,
        isSuperAdmin: makeSuper,
      });
      flash.ok(`已通过「${req.username}」的注册申请`);
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setRegBusy(false);
    }
  };

  const rejectRegistration = async (id: number) => {
    setRegBusy(true);
    try {
      await api.post(`/api/admin/registrations/${id}/reject`, { reason: rejectReason.trim() });
      flash.ok('已拒绝该注册申请');
      setRejectingReqId(null);
      setRejectReason('');
      await reloadAll();
    } catch (err) {
      flash.fail(errorText(err));
    } finally {
      setRegBusy(false);
    }
  };

  const permLabelMap = new Map((permissions.data ?? []).map((p) => [p.id, p.label]));

  return (
    <div>
      <div className="page-head">
        <div className="page-title-group">
          <h1>用户与权限</h1>
          <p className="page-subtitle">
            管理平台账号、角色权限分配、注册审批与安全审计日志。账号仅禁用不删除，以保留操作追溯。
          </p>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void reloadAll()}>
            刷新
          </button>
        </div>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="权限管理分区">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'users'}
          className={`share-filter-pill ${tab === 'users' ? 'active' : ''}`}
          onClick={() => setTab('users')}
        >
          用户管理 ({users.data?.length ?? 0})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'roles'}
          className={`share-filter-pill ${tab === 'roles' ? 'active' : ''}`}
          onClick={() => setTab('roles')}
        >
          角色与权限 ({roles.data?.length ?? 0})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'registrations'}
          className={`share-filter-pill ${tab === 'registrations' ? 'active' : ''}`}
          onClick={() => setTab('registrations')}
        >
          注册申请 {pendingCount > 0 ? `(${pendingCount} 待审)` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'audit'}
          className={`share-filter-pill ${tab === 'audit' ? 'active' : ''}`}
          onClick={() => setTab('audit')}
        >
          审计日志
        </button>
      </div>

      {tab === 'users' && (
        <>
          {issuedCredential && (
            <div className="alert ok cred-banner" role="status">
              <div className="cred-banner-text">
                <strong>
                  {issuedCredential.action === 'created' ? '账号已创建' : '密码已重置'}（请复制发送给用户，首次登录将强制修改）：
                </strong>{' '}
                用户名 <code>{issuedCredential.username}</code> · 初始密码{' '}
                <code>{issuedCredential.password}</code>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="secondary small"
                  onClick={() =>
                    void copyWithFeedback(
                      `用户名：${issuedCredential.username}\n初始密码：${issuedCredential.password}`,
                      '已复制账号与初始密码'
                    )
                  }
                >
                  复制账号与密码
                </button>
                <button
                  type="button"
                  className="link small"
                  onClick={() => setIssuedCredential(null)}
                >
                  关闭
                </button>
              </div>
            </div>
          )}
          <div className="split providers-split">
            <section className="card" ref={userFormRef}>
              <h2>
                {resetUser
                  ? `重置密码：${resetUser.username}`
                  : editingUser
                    ? `编辑账号：${editingUser.username}`
                    : '添加账号'}
              </h2>
              {resetUser ? (
                <form className="form" onSubmit={submitResetPassword}>
                  <label>
                    新密码（至少 8 位含字母数字，下次登录强制修改）
                    <div className="actions">
                      <input
                        value={resetPwd}
                        onChange={(e) => setResetPwd(e.target.value)}
                        minLength={8}
                        required
                        autoFocus
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => setResetPwd(generateRandomPassword())}
                      >
                        随机生成
                      </button>
                      <button
                        type="button"
                        className="secondary small"
                        disabled={!resetPwd}
                        onClick={() => void copyWithFeedback(resetPwd, '已复制新密码')}
                      >
                        复制
                      </button>
                    </div>
                  </label>
                  <div className="actions">
                    <button type="submit" className="primary" disabled={userBusy}>
                      确认重置
                    </button>
                    <button type="button" className="secondary" onClick={() => setResetUser(null)}>
                      取消
                    </button>
                  </div>
                </form>
              ) : editingUser ? (
              <form className="form" onSubmit={saveEditUser}>
                <label>
                  显示名称
                  <input
                    value={editDisplayName}
                    onChange={(e) => setEditDisplayName(e.target.value)}
                    required
                  />
                </label>
                <label>
                  邮箱
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </label>
                {isSuperAdmin && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={editIsSuper}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setEditIsSuper(checked);
                        if (!checked && !assignableRoles.some((r) => String(r.id) === editRoleId)) {
                          setEditRoleId(String(defaultDevRoleId));
                        }
                      }}
                    />
                    <span>设为超级管理员（拥有全部权限）</span>
                  </label>
                )}
                {!editIsSuper && (
                  <label>
                    所属角色
                    <select value={editRoleId} onChange={(e) => setEditRoleId(e.target.value)}>
                      {assignableRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="actions">
                  <button type="submit" className="primary" disabled={userBusy}>
                    保存修改
                  </button>
                  <button type="button" className="secondary" onClick={() => setEditingUser(null)}>
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <form className="form" onSubmit={handleCreateUser}>
                <label htmlFor={ids.username}>
                  用户名
                  <input
                    id={ids.username}
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="如 zhangsan"
                    required
                  />
                </label>
                <label htmlFor={ids.displayName}>
                  显示名称
                  <input
                    id={ids.displayName}
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    placeholder="如 张三"
                    required
                  />
                </label>
                <label htmlFor={ids.email}>
                  邮箱（可选）
                  <input
                    id={ids.email}
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </label>
                {isSuperAdmin && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={newIsSuper}
                      onChange={(e) => setNewIsSuper(e.target.checked)}
                    />
                    <span>设为超级管理员</span>
                  </label>
                )}
                {!newIsSuper && (
                  <label htmlFor={ids.role}>
                    分配角色
                    <select
                      id={ids.role}
                      value={newRoleId || String(defaultDevRoleId)}
                      onChange={(e) => setNewRoleId(e.target.value)}
                    >
                      {assignableRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label htmlFor={ids.password}>
                  初始密码（至少 8 位含字母数字，首次登录强制修改）
                  <div className="actions">
                    <input
                      id={ids.password}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={8}
                      required
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => setNewPassword(generateRandomPassword())}
                    >
                      随机生成
                    </button>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={!newPassword}
                      onClick={() => void copyWithFeedback(newPassword, '已复制初始密码')}
                    >
                      复制
                    </button>
                  </div>
                </label>
                <div className="actions">
                  <button type="submit" className="primary" disabled={userBusy}>
                    创建账号
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="card grow">
            <h2>账号列表</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>用户名</th>
                    <th>显示名</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>最近登录</th>
                    <th className="actions-cell">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(users.data ?? []).map((u) => (
                    <tr key={u.id}>
                      <td className="mono">{u.username}</td>
                      <td>
                        <span className="cell-title">{u.displayName}</span>
                        {u.email && <span className="cell-sub small">{u.email}</span>}
                      </td>
                      <td>
                        <span className={`tag ${u.isSuperAdmin ? 'ok' : ''}`}>
                          {u.isSuperAdmin ? '超级管理员' : (u.roleName ?? '未分配')}
                        </span>
                      </td>
                      <td>
                        <span className={`tag ${u.status === 'active' ? 'ok' : 'failed'}`}>
                          {u.status === 'active' ? '启用' : '已禁用'}
                        </span>
                      </td>
                      <td className="small">{formatTime(u.lastLoginAt)}</td>
                      <td className="actions-cell">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="link"
                            disabled={u.isSuperAdmin && !isSuperAdmin}
                            onClick={() => startEditUser(u)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="link"
                            disabled={u.isSuperAdmin && !isSuperAdmin}
                            onClick={() => {
                              setEditingUser(null);
                              setResetUser(u);
                              setResetPwd(generateRandomPassword());
                              scrollToUserForm();
                            }}
                          >
                            重置密码
                          </button>
                          {u.id !== myId && (
                            <button
                              type="button"
                              className={`link ${u.status === 'active' ? 'danger' : ''}`}
                              disabled={u.isSuperAdmin && !isSuperAdmin}
                              onClick={() => void toggleUserStatus(u)}
                            >
                              {u.status === 'active' ? '禁用' : '启用'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        </>
      )}

      {tab === 'roles' && (
        <div className="split providers-split">
          <section className="card">
            <h2>{editingRoleId ? '编辑角色权限' : '新建自定义角色'}</h2>
            <form className="form" onSubmit={saveRole}>
              <label htmlFor={ids.roleName}>
                角色名称
                <input
                  id={ids.roleName}
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  required
                  disabled={Boolean(
                    editingRoleId && roles.data?.find((r) => r.id === editingRoleId)?.builtin
                  )}
                />
              </label>
              <label htmlFor={ids.roleDesc}>
                说明
                <input
                  id={ids.roleDesc}
                  value={roleDesc}
                  onChange={(e) => setRoleDesc(e.target.value)}
                  placeholder="简要说明该角色的职责"
                />
              </label>
              <fieldset className="provider-pool">
                <legend>赋予权限</legend>
                {(permissions.data ?? []).map((p) => {
                  const canGrant = isSuperAdmin || myPerms.includes(p.id);
                  return (
                    <label key={p.id} className="checkbox">
                      <input
                        type="checkbox"
                        checked={rolePerms.includes(p.id)}
                        disabled={!canGrant}
                        onChange={() => toggleRolePerm(p.id)}
                      />
                      <span>
                        <strong>{p.label}</strong>
                        <span className="small muted"> — {p.description}</span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <div className="actions">
                <button type="submit" className="primary" disabled={roleBusy}>
                  {editingRoleId ? '保存角色' : '创建角色'}
                </button>
                {editingRoleId && (
                  <button type="button" className="secondary" onClick={resetRoleForm}>
                    取消编辑
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="card grow">
            <h2>角色列表</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>人数</th>
                    <th>拥有权限</th>
                    <th className="actions-cell">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(roles.data ?? []).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="cell-title">
                          {r.name} {r.builtin && <span className="tag">内置</span>}
                        </span>
                        {r.description && <span className="small muted">{r.description}</span>}
                      </td>
                      <td>{r.userCount}</td>
                      <td>
                        <div className="row-actions">
                          {r.name === '超级管理员' ? (
                            <span className="tag ok">全部权限</span>
                          ) : r.permissions.length === 0 ? (
                            <span className="small muted">仅只读查看</span>
                          ) : (
                            r.permissions.map((p) => (
                              <span key={p} className="tag category">
                                {permLabelMap.get(p) ?? p}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="actions-cell">
                        {r.name !== '超级管理员' && (
                          <div className="row-actions">
                            <button type="button" className="link" onClick={() => startEditRole(r)}>
                              编辑
                            </button>
                            {!r.builtin && (
                              <button
                                type="button"
                                className="link danger"
                                onClick={() => void deleteRole(r)}
                              >
                                删除
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === 'registrations' && (
        <section className="card">
          <div className="card-head">
            <h2>注册申请审批</h2>
            <div className="actions">
              <span className="small muted">
                登录页自助注册：{regSetting.data?.enabled ? '已开启' : '已关闭'}
              </span>
              <button
                type="button"
                className="secondary small"
                onClick={() => void toggleRegistrationEnabled()}
              >
                {regSetting.data?.enabled ? '关闭自助注册' : '开启自助注册'}
              </button>
            </div>
          </div>

          {(registrations.data ?? []).length === 0 ? (
            <p className="muted">暂无注册申请。</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>申请人</th>
                    <th>申请理由</th>
                    <th>来源 IP / 时间</th>
                    <th>状态</th>
                    <th className="actions-cell">审批操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(registrations.data ?? []).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="cell-title">
                          {r.displayName} <code className="mono">{r.username}</code>
                        </span>
                        {r.email && <span className="small muted">{r.email}</span>}
                      </td>
                      <td className="prewrap small">{r.reason || '—'}</td>
                      <td className="small">
                        <div className="mono">{r.ip || '—'}</div>
                        <div className="muted">{formatTime(r.createdAt)}</div>
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            r.status === 'approved'
                              ? 'ok'
                              : r.status === 'rejected'
                                ? 'failed'
                                : 'queued'
                          }`}
                        >
                          {r.status === 'pending'
                            ? '待审批'
                            : r.status === 'approved'
                              ? `已通过（${r.roleName ?? ''}）`
                              : '已拒绝'}
                        </span>
                        {r.rejectReason && (
                          <div className="small muted">理由：{r.rejectReason}</div>
                        )}
                      </td>
                      <td className="actions-cell">
                        {r.status === 'pending' ? (
                          <div className="stack" style={{ gap: 6 }}>
                            <div className="row-actions">
                              {!approveSuperByReq[r.id] && (
                                <select
                                  aria-label="审批角色"
                                  value={approveRoleByReq[r.id] ?? String(defaultDevRoleId)}
                                  onChange={(e) =>
                                    setApproveRoleByReq((prev) => ({ ...prev, [r.id]: e.target.value }))
                                  }
                                  style={{ width: 'auto', minWidth: 130 }}
                                >
                                  {assignableRoles.map((role) => (
                                    <option key={role.id} value={role.id}>
                                      {role.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {isSuperAdmin && (
                                <label className="checkbox small">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(approveSuperByReq[r.id])}
                                    onChange={(e) =>
                                      setApproveSuperByReq((prev) => ({
                                        ...prev,
                                        [r.id]: e.target.checked,
                                      }))
                                    }
                                  />
                                  <span>超管</span>
                                </label>
                              )}
                              <button
                                type="button"
                                className="primary small"
                                disabled={regBusy}
                                onClick={() => void approveRegistration(r)}
                              >
                                通过
                              </button>
                              <button
                                type="button"
                                className="link danger"
                                disabled={regBusy}
                                onClick={() => {
                                  setRejectingReqId(r.id);
                                  setRejectReason('');
                                }}
                              >
                                拒绝
                              </button>
                            </div>
                            {rejectingReqId === r.id && (
                              <div className="row-actions">
                                <input
                                  value={rejectReason}
                                  onChange={(e) => setRejectReason(e.target.value)}
                                  placeholder="填写拒绝原因（可选）"
                                  style={{ minWidth: 180 }}
                                />
                                <button
                                  type="button"
                                  className="danger small"
                                  disabled={regBusy}
                                  onClick={() => void rejectRegistration(r.id)}
                                >
                                  确认拒绝
                                </button>
                                <button
                                  type="button"
                                  className="link"
                                  onClick={() => setRejectingReqId(null)}
                                >
                                  取消
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="small muted">
                            {r.reviewedByName ? `审批人：${r.reviewedByName}` : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'audit' && (
        <section className="card">
          <h2>安全与权限审计日志</h2>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作人</th>
                  <th>动作</th>
                  <th>目标</th>
                  <th>详情</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {(auditLogs.data ?? []).map((log) => (
                  <tr key={log.id}>
                    <td className="small nowrap">{formatTime(log.createdAt)}</td>
                    <td className="mono">{log.username}</td>
                    <td>
                      <span className="tag category">{log.action}</span>
                    </td>
                    <td className="mono">{log.target ?? '—'}</td>
                    <td className="small">{log.detail ?? '—'}</td>
                    <td className="mono small">{log.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
