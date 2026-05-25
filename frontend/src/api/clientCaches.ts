import type { TeamAnalysis } from '../types';

/**
 * Client-side caches for the two slow AI endpoints. Module-level so they
 * survive route changes (React component unmounts won't drop the data).
 *
 * The server also caches these by (rosterHash + prefsHash), so this client
 * cache is purely an optimization to skip the HTTP round trip on tab switches.
 *
 * Invalidate explicitly on any mutation that would change the server's cache
 * key — adding/dropping a roster player, or saving new preferences.
 */

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

interface Suggestions {
  trade_targets: Array<{ name: string; reasoning: string }>;
  waiver_pickups: Array<{ name: string; reasoning: string }>;
  summary: string;
  cached?: boolean;
  cached_at?: string;
}

let analysis: CacheEntry<TeamAnalysis> | null = null;
let suggestions: CacheEntry<Suggestions> | null = null;

// 30 minutes — generous because we explicitly invalidate on the events that
// actually matter (roster mutation, prefs save). The TTL is just a safety net.
const TTL_MS = 30 * 60_000;

function isFresh<T>(entry: CacheEntry<T> | null): boolean {
  return !!entry && Date.now() - entry.fetchedAt < TTL_MS;
}

export function getCachedAnalysis(): TeamAnalysis | null {
  return isFresh(analysis) ? analysis!.data : null;
}

export function setCachedAnalysis(data: TeamAnalysis): void {
  analysis = { data, fetchedAt: Date.now() };
}

export function getCachedSuggestions(): Suggestions | null {
  return isFresh(suggestions) ? suggestions!.data : null;
}

export function setCachedSuggestions(data: Suggestions): void {
  suggestions = { data, fetchedAt: Date.now() };
}

/** Wipe both caches. Call when the underlying data definitely changed. */
export function invalidateAIClientCaches(): void {
  analysis = null;
  suggestions = null;
}
