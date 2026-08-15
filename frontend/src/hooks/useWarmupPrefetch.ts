import { useEffect } from 'react';
import { prefetchCached, CACHE_KEYS } from '../api/resourceCache';
import { getPlayers, getTeams, getMyRoster, getBettingOdds, getBets } from '../api/client';

const WARMUP_DELAY_MS = 1500;

// the ai endpoints are excluded on purpose: each generation costs money.
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
