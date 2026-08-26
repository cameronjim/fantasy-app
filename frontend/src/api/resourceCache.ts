interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// past this age a cached copy still renders instantly, but a background refetch runs.
export const FRESH_MS = 60_000;

export const CACHE_KEYS = {
  players: 'players',
  teams: 'teams',
  roster: 'roster',
  odds: 'betting-odds',
  bets: 'bets',
  historySeasons: 'history-seasons',
} as const;

export function historyPlayersKey(season: string): string {
  return `history-players:${season}`;
}

export function historyTeamsKey(season: string): string {
  return `history-teams:${season}`;
}

export function playerAnalyticsKey(playerId: number): string {
  return `player-analytics:${playerId}`;
}

export function playerPredictionsKey(playerId: number): string {
  return `player-predictions:${playerId}`;
}

export function ratings2kPlayersKey(teamType: string): string {
  return `ratings2k-players:${teamType}`;
}

export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  return entry ? (entry.data as T) : null;
}

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

export function clearCachedResources(): void {
  store.clear();
  inflight.clear();
}

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

export function prefetchCached<T>(key: string, fetcher: () => Promise<T>): void {
  const age = getCachedAge(key);
  if (age !== null && age < FRESH_MS) return;
  if (inflight.has(key)) return;
  fetchCached(key, fetcher).catch(() => {
    // warm-up failures are silent: the page that needs the data retries.
  });
}
