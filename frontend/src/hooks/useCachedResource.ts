import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCached, getCached, getCachedAge, invalidateCached, FRESH_MS } from '../api/resourceCache';

export interface CachedResource<T> {
  // null until the first successful fetch (or cache hit) for this key.
  data: T | null;
  // true only while fetching with nothing cached — the spinner case.
  loading: boolean;
  // true while silently revalidating behind an already-rendered cached copy.
  refreshing: boolean;
  error: string;
  // drops the cache and refetches with a visible loading state.
  reload: () => Promise<void>;
}

/**
 * Stale-while-revalidate around the module-level resource cache: a cached
 * copy renders instantly on mount (no spinner on tab return), and a silent
 * background refetch keeps it current once it's older than FRESH_MS.
 */
export function useCachedResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean; errorMessage?: string } = {}
): CachedResource<T> {
  const { enabled = true, errorMessage = 'Failed to load data' } = options;
  const [data, setData] = useState<T | null>(() => (enabled ? getCached<T>(key) : null));
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // callers pass inline fetchers — a ref keeps their changing identity from
  // re-triggering the mount effect on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async (visible: boolean): Promise<void> => {
    if (visible) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const result = await fetchCached(key, fetcherRef.current);
      setData(result);
    } catch {
      setError(errorMessage);
    } finally {
      if (visible) setLoading(false);
      else setRefreshing(false);
    }
  }, [key, errorMessage]);

  useEffect(() => {
    if (!enabled) return;
    const age = getCachedAge(key);
    if (age === null) {
      void run(true);
      return;
    }
    setData(getCached<T>(key));
    if (age >= FRESH_MS) void run(false);
  }, [key, enabled, run]);

  const reload = useCallback(async (): Promise<void> => {
    invalidateCached(key);
    await run(true);
  }, [key, run]);

  return { data, loading, refreshing, error, reload };
}
