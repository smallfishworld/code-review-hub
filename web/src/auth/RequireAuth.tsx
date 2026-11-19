import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/** Redirects to /login when the session is not authenticated. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (status && status.loginRequired && !status.authenticated) {
      navigate('/login', { replace: true });
    }
  }, [status, loading, navigate]);

  if (loading) return <div className="page-loading">加载中…</div>;
  if (status && status.loginRequired && !status.authenticated) {
    return <div className="page-loading">未登录，正在跳转…</div>;
  }
  return <>{children}</>;
}
