import { useEffect } from 'react';
import { prefetchCached, CACHE_KEYS } from '../api/resourceCache';
import { getPlayers, getTeams, getMyRoster, getBettingOdds, getBets } from '../api/client';

// short enough that the warm copies are ready before a human reaches for
// another tab, long enough that the landing page's own requests go first.
const WARMUP_DELAY_MS = 1500;

/**
 * After first paint, quietly warms the data every tab needs so the first
 * visit to each is instant. The Claude-backed endpoints are deliberately
 * excluded — they cost real money per generation and have their own
 * server + client caches.
 */
export function useWarmupPrefetch(isLoggedIn: boolean): void {
  useEffect(() => {
    const timer = setTimeout(() => {
      prefetchCached(CACHE_KEYS.players, () => getPlayers());
      prefetchCached(CACHE_KEYS.teams, getTeams);
      prefetchCached(CACHE_KEYS.odds, getBettingOdds);
      if (isLoggedIn) {
        prefetchCached(CACHE_KEYS.roster, getMyRoster);
        prefetchCached(CACHE_KEYS.bets, getBets);
      }
    }, WARMUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isLoggedIn]);
}
