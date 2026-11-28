import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { Permission } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useI18n, type MessageKey } from '../i18n';

interface NavItem {
  to: string;
  labelKey?: MessageKey;
  label?: string;
  perm?: Permission;
  badge?: number;
  icon: ReactNode;
}

interface NavGroup {
  titleKey: MessageKey;
  items: NavItem[];
}

const iconProps = {
  className: 'nav-icon',
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

const NAV_GROUPS: NavGroup[] = [
  {
    titleKey: 'nav.group.workspace',
    items: [
      {
        to: '/repos',
        labelKey: 'nav.repos',
        icon: (
          <svg {...iconProps}>
            <path d="M3.5 5.5A2 2 0 0 1 5.5 3.5h3.2l1.8 2h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9Z" />
            <path d="M7.5 11h5" />
          </svg>
        ),
      },
      {
        to: '/monitor',
        labelKey: 'nav.monitor',
        icon: (
          <svg {...iconProps}>
            <path d="M3 10h3l2-5 4 10 2-5h3" />
          </svg>
        ),
      },
      {
        to: '/trigger',
        labelKey: 'nav.trigger',
        perm: 'review:trigger',
        icon: (
          <svg {...iconProps}>
            <path d="M6.5 4.8v10.4L15.2 10 6.5 4.8Z" />
          </svg>
        ),
      },
      {
        to: '/tasks',
        labelKey: 'nav.tasks',
        icon: (
          <svg {...iconProps}>
            <rect x="4" y="3.5" width="12" height="13" rx="2" />
            <path d="M7.2 8h5.6M7.2 11.2h5.6M7.2 14.2h3.2" />
          </svg>
        ),
      },
    ],
  },
  {
    titleKey: 'nav.group.models',
    items: [
      {
        to: '/providers',
        labelKey: 'nav.providers',
        perm: 'provider:edit',
        icon: (
          <svg {...iconProps}>
            <rect x="5.5" y="5.5" width="9" height="9" rx="1.8" />
            <path d="M8 3v2.5M12 3v2.5M8 14.5V17M12 14.5V17M3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17" />
          </svg>
        ),
      },
      {
        to: '/engines',
        labelKey: 'nav.engines',
        perm: 'engine:edit',
        icon: (
          <svg {...iconProps}>
            <path d="M10 3.5 16.5 7 10 10.5 3.5 7 10 3.5Z" />
            <path d="m3.5 10.5 6.5 3.5 6.5-3.5M3.5 13.8 10 17.2l6.5-3.4" />
          </svg>
        ),
      },
      {
        to: '/mcp',
        labelKey: 'nav.mcp',
        perm: 'mcp:edit',
        icon: (
          <svg {...iconProps}>
            <path d="M7.5 6.5v-3M12.5 6.5v-3M5.5 6.5h9v3a4.5 4.5 0 0 1-9 0v-3ZM10 14v3" />
          </svg>
        ),
      },
    ],
  },
  {
    titleKey: 'nav.group.ops',
    items: [
      {
        to: '/notifications',
        labelKey: 'nav.notifications',
        perm: 'notification:edit',
        icon: (
          <svg {...iconProps}>
            <path d="M10 3.5a4.5 4.5 0 0 0-4.5 4.5v2.8l-1.5 2.2h12l-1.5-2.2V8A4.5 4.5 0 0 0 10 3.5Z" />
            <path d="M8.5 15.5a1.8 1.8 0 0 0 3 0" />
          </svg>
        ),
      },
      {
        to: '/logs',
        labelKey: 'nav.logs',
        perm: 'log:manage',
        icon: (
          <svg {...iconProps}>
            <rect x="3.5" y="4" width="13" height="12" rx="2" />
            <path d="m6.8 8 2.2 2-2.2 2M10.5 12h2.8" />
          </svg>
        ),
      },
      {
        to: '/admin/users',
        label: '用户与权限',
        perm: 'user:manage',
        icon: (
          <svg {...iconProps}>
            <circle cx="8" cy="7" r="2.5" />
            <path d="M3.5 15.5a4.5 4.5 0 0 1 9 0" />
            <circle cx="14.2" cy="8" r="1.8" />
            <path d="M13 15.5a3.2 3.2 0 0 1 3.8-2.5" />
          </svg>
        ),
      },
      {
        to: '/settings',
        labelKey: 'nav.settings',
        icon: (
          <svg {...iconProps}>
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 3.2v1.9M10 14.9v1.9M3.2 10h1.9M14.9 10h1.9M5.2 5.2l1.3 1.3M13.5 13.5l1.3 1.3M14.8 5.2l-1.3 1.3M6.5 13.5l-1.3 1.3" />
          </svg>
        ),
      },
    ],
  },
];

export function Layout() {
  const { status, logout, can } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const userName = status?.displayName ?? status?.username ?? t('common.notLoggedIn');
  const userInitial = userName.slice(0, 1).toUpperCase();
  const pendingRegs = status?.pendingRegistrations ?? 0;

  return (
    <div className="app-shell">
      {/* First tab stop: bypasses the repeated navigation. */}
      <a href="#main-content" className="skip-link">
        {t('nav.skipToContent')}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/logo.png" alt="" aria-hidden="true" width={32} height={32} />
          <div className="brand-text">
            <span className="brand-title">{t('app.name')}</span>
            <span className="brand-sub">{t('app.subtitle')}</span>
          </div>
        </div>
        <nav aria-label={t('nav.mainAria')} className="nav-groups">
          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) => !item.perm || can(item.perm));
            if (visibleItems.length === 0) return null;
            return (
              <div key={group.titleKey} className="nav-group">
                <div className="nav-group-label">{t(group.titleKey)}</div>
                <div className="nav-group-items">
                  {visibleItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
                      aria-current={location.pathname === item.to ? 'page' : undefined}
                    >
                      {item.icon}
                      <span>{item.labelKey ? t(item.labelKey) : item.label}</span>
                      {item.to === '/admin/users' && pendingRegs > 0 && (
                        <span className="nav-badge" aria-label={`${pendingRegs} 条待审批`}>
                          {pendingRegs}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-footer">
            <Link to="/account" className="user-badge" title="我的账号">
              <span className="user-avatar" aria-hidden="true">
                {userInitial}
              </span>
              <span className="user-name">{userName}</span>
            </Link>
            <button type="button" className="link small" onClick={doLogout}>
              {t('common.logout')}
            </button>
          </div>
        </div>
      </aside>
      <main className="content" id="main-content" tabIndex={-1}>
        <div className="content-inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
