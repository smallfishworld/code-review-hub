import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { Permission } from '../api/client';
import { useI18n } from '../i18n';

/** Redirects to /login when unauthenticated (preserving target path), or /account when password change is forced. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, loading } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  const mustChangeRedirect = Boolean(
    status?.authenticated && status.user?.mustChangePassword && location.pathname !== '/account'
  );

  useEffect(() => {
    if (loading || !status) return;
    if (status.loginRequired && !status.authenticated) {
      navigate('/login', { replace: true, state: { from } });
      return;
    }
    if (mustChangeRedirect) {
      navigate('/account', { replace: true, state: { from } });
    }
  }, [status, loading, navigate, from, mustChangeRedirect]);

  if (loading) return <div className="page-loading">{t('common.loading')}</div>;
  if (status && status.loginRequired && !status.authenticated) {
    return <div className="page-loading">{t('auth.redirecting')}</div>;
  }
  if (mustChangeRedirect) {
    return <div className="page-loading">{t('auth.redirecting')}</div>;
  }
  return <>{children}</>;
}

export function RequirePermission({
  perm,
  children,
}: {
  perm: Permission;
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  const { t } = useI18n();
  if (!can(perm)) {
    return (
      <div className="card narrow">
        <h2>{t('auth.forbiddenTitle')}</h2>
        <p className="muted">{t('auth.forbiddenBody')}</p>
        <div className="actions">
          <Link to="/repos" className="btn-link secondary">
            {t('auth.backHome')}
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
