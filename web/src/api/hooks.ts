import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../api/client';

/** Fetch data with loading/error state and a manual reload. */
export function useApi<T>(
  loader: () => Promise<T>,
  deps: unknown[] = []
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await run();
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as ApiError).message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export function errorText(err: unknown): string {
  return (err as ApiError)?.message ?? String(err);
}

/** Keep the document title in sync with the current view (SPA route change). */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · 代码评审平台`;
  }, [title]);
}
