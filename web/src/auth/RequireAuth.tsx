import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';

/** Redirects to /login when the session is not authenticated. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, loading } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (status && status.loginRequired && !status.authenticated) {
      navigate('/login', { replace: true });
    }
  }, [status, loading, navigate]);

  if (loading) return <div className="page-loading">{t('common.loading')}</div>;
  if (status && status.loginRequired && !status.authenticated) {
    return <div className="page-loading">{t('auth.redirecting')}</div>;
  }
  return <>{children}</>;
}
