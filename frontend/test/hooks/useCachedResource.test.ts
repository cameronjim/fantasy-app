import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCachedResource } from '../../src/hooks/useCachedResource';
import { setCached, getCached, FRESH_MS } from '../../src/api/resourceCache';

// the global setup clears the resource cache before each test.

describe('useCachedResource', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches with a visible loading state when nothing is cached', async () => {
    const fetcher = vi.fn().mockResolvedValue(['fresh']);

    const { result } = renderHook(() => useCachedResource<string[]>('key', fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual(['fresh']));
    expect(result.current.loading).toBe(false);
    expect(getCached('key')).toEqual(['fresh']);
  });

  it('serves a fresh cached copy instantly without touching the network', () => {
    setCached('key', ['cached']);
    const fetcher = vi.fn().mockResolvedValue(['fresh']);

    const { result } = renderHook(() => useCachedResource<string[]>('key', fetcher));

    expect(result.current.data).toEqual(['cached']);
    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves a stale cached copy instantly and revalidates in the background', async () => {
    setCached('key', ['stale']);
    vi.advanceTimersByTime(FRESH_MS + 1);
    const fetcher = vi.fn().mockResolvedValue(['fresh']);

    const { result } = renderHook(() => useCachedResource<string[]>('key', fetcher));

    expect(result.current.data).toEqual(['stale']);
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.data).toEqual(['fresh']));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reload drops the cache and refetches visibly', async () => {
    setCached('key', ['cached']);
    const fetcher = vi.fn().mockResolvedValue(['reloaded']);
    const { result } = renderHook(() => useCachedResource<string[]>('key', fetcher));

    await result.current.reload();

    await waitFor(() => expect(result.current.data).toEqual(['reloaded']));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces the configured error message when the fetch fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useCachedResource<string[]>('key', fetcher, { errorMessage: 'Failed to load odds' })
    );

    await waitFor(() => expect(result.current.error).toBe('Failed to load odds'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('does nothing while disabled', () => {
    const fetcher = vi.fn().mockResolvedValue(['fresh']);

    const { result } = renderHook(() =>
      useCachedResource<string[]>('key', fetcher, { enabled: false })
    );

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
