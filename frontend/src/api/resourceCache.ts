/**
 * Generic module-level cache for the cheap GET resources (players, teams,
 * roster, odds, ledger). Survives route changes so tab switches render
 * instantly from the last copy; useCachedResource layers stale-while-
 * revalidate on top. The slow AI responses have their own cache with
 * event-based invalidation in clientCaches.ts.
 */

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// inside this window a cached copy is served without touching the network;
// past it the copy still renders instantly but a background refetch runs.
export const FRESH_MS = 60_000;

export const CACHE_KEYS = {
  players: 'players',
  teams: 'teams',
  roster: 'roster',
  odds: 'betting-odds',
  bets: 'bets',
  historySeasons: 'history-seasons',
} as const;

/** Each historical season caches under its own key so flipping the season
 *  dropdown back and forth never refetches a table we already have. */
export function historyPlayersKey(season: string): string {
  return `history-players:${season}`;
}

/** Same per-season keying for the historical team tables. */
export function historyTeamsKey(season: string): string {
  return `history-teams:${season}`;
}

/** One key per player so bouncing between analytics pages (or back from the
 *  stats table) re-renders instantly instead of refetching a heavy payload. */
export function playerAnalyticsKey(playerId: number): string {
  return `player-analytics:${playerId}`;
}

/** One key per 2K roster (current / classic / all-time) so toggling between
 *  them never refetches a list we already have. */
export function ratings2kPlayersKey(teamType: string): string {
  return `ratings2k-players:${teamType}`;
}

export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  return entry ? (entry.data as T) : null;
}

/** milliseconds since the entry was stored, or null when nothing is cached. */
export function getCachedAge(key: string): number | null {
  const entry = store.get(key);
  return entry ? Date.now() - entry.fetchedAt : null;
}

export function setCached<T>(key: string, data: T): void {
  store.set(key, { data, fetchedAt: Date.now() });
}

export function invalidateCached(key: string): void {
  store.delete(key);
}

/** test hook — wipes every entry so module state never leaks between tests. */
export function clearCachedResources(): void {
  store.clear();
  inflight.clear();
}

/**
 * Fetch and store, de-duplicating concurrent calls for the same key (the
 * warm-up prefetch and a page mount can race for the same resource).
 */
export function fetchCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = fetcher()
    .then((data) => {
      setCached(key, data);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Fire-and-forget warm-up — a no-op when a fresh copy or in-flight fetch exists. */
export function prefetchCached<T>(key: string, fetcher: () => Promise<T>): void {
  const age = getCachedAge(key);
  if (age !== null && age < FRESH_MS) return;
  if (inflight.has(key)) return;
  fetchCached(key, fetcher).catch(() => {
    // warm-up failures are invisible by design — the page that actually
    // needs the data will retry and surface its own error state.
  });
}
