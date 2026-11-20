import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV = [
  { to: '/repos', label: '仓库管理' },
  { to: '/monitor', label: '监控规则' },
  { to: '/tasks', label: '任务与报告' },
  { to: '/trigger', label: '手动触发' },
  { to: '/providers', label: 'LLM Provider' },
  { to: '/engines', label: '评审引擎' },
  { to: '/mcp', label: 'MCP 服务器' },
  { to: '/notifications', label: '通知配置' },
  { to: '/logs', label: '运行日志' },
  { to: '/settings', label: '系统设置' },
];

export function Layout() {
  const { status, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      {/* First tab stop: bypasses the repeated navigation. */}
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">代码评审平台</div>
        <nav aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              aria-current={location.pathname === item.to ? 'page' : undefined}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="muted">{status?.displayName ?? status?.username ?? '未登录'}</span>
          <button type="button" className="link" onClick={doLogout}>
            退出
          </button>
        </div>
      </aside>
      <main className="content" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
