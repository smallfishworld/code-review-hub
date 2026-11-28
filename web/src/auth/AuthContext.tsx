import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  setAuthToken,
  setUnauthorizedHandler,
  type AuthStatus,
  type AuthUserInfo,
  type Permission,
} from '../api/client';

const TOKEN_KEY = 'crp_token';

interface AuthState {
  status: AuthStatus | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<AuthUserInfo>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (perm: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<AuthStatus>('/api/auth/status');
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    setAuthToken(localStorage.getItem(TOKEN_KEY));
    setUnauthorizedHandler(() => {
      localStorage.removeItem(TOKEN_KEY);
      setAuthToken(null);
      void refresh();
    });
    void refresh().finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<{ token: string; user: AuthUserInfo }>('/api/auth/login', {
        username,
        password,
      });
      localStorage.setItem(TOKEN_KEY, res.token);
      setAuthToken(res.token);
      await refresh();
      return res.user;
    },
    [refresh]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // ignore: clearing the local token is enough
    }
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    await refresh();
  }, [refresh]);

  const can = useCallback(
    (perm: Permission): boolean => {
      if (!status) return false;
      if (!status.loginRequired) return true;
      const user = status.user;
      if (!user) return false;
      if (user.isSuperAdmin) return true;
      return user.permissions.includes(perm);
    },
    [status]
  );

  const value = useMemo(
    () => ({ status, loading, login, logout, refresh, can }),
    [status, loading, login, logout, refresh, can]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function usePermission(perm: Permission): boolean {
  return useAuth().can(perm);
}
