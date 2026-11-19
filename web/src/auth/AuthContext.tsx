import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setAuthToken, setUnauthorizedHandler, type AuthStatus } from '../api/client';

/**
 * Auth context. The token lives in localStorage and is injected into the API
 * client here; swapping to a cookie/OA session only means changing this file.
 */

const TOKEN_KEY = 'crp_token';

interface AuthState {
  status: AuthStatus | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
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
      const res = await api.post<{ token: string }>('/api/auth/login', { username, password });
      localStorage.setItem(TOKEN_KEY, res.token);
      setAuthToken(res.token);
      await refresh();
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

  const value = useMemo(
    () => ({ status, loading, login, logout, refresh }),
    [status, loading, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
