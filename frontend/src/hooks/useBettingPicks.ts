import { useCallback, useEffect, useState } from 'react';
import { getBettingOdds, getBettingPicks } from '../api/client';
import {
  getCachedBettingPicks,
  setCachedBettingPicks,
  invalidateBettingClientCache,
} from '../api/clientCaches';
import type { BettingGame, BettingPicksResponse } from '../types';

interface UseBettingPicks {
  odds: BettingGame[];
  oddsLoading: boolean;
  oddsError: string;
  reloadOdds: () => void;
  picks: BettingPicksResponse | null;
  picksLoading: boolean;
  refreshing: boolean;
  picksError: string;
  reloadPicks: (refresh?: boolean) => Promise<void>;
}

/**
 * Loads the public odds board for everyone and the AI picks for signed-in
 * users. Picks hydrate from the module-level client cache so tab switches
 * don't re-trigger a slow AI round trip.
 */
export function useBettingPicks(isLoggedIn: boolean): UseBettingPicks {
  const [initialPicks] = useState(() => (isLoggedIn ? getCachedBettingPicks() : null));
  const [odds, setOdds] = useState<BettingGame[]>([]);
  const [oddsLoading, setOddsLoading] = useState(true);
  const [oddsError, setOddsError] = useState('');
  const [picks, setPicks] = useState<BettingPicksResponse | null>(initialPicks);
  const [picksLoading, setPicksLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [picksError, setPicksError] = useState('');

  const reloadOdds = useCallback((): void => {
    setOddsLoading(true);
    setOddsError('');
    getBettingOdds()
      .then((data) => setOdds(data.games))
      .catch(() => setOddsError('Failed to load odds. ESPN may be unavailable — try again in a minute.'))
      .finally(() => setOddsLoading(false));
  }, []);

  const reloadPicks = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) {
      invalidateBettingClientCache();
      setRefreshing(true);
    } else {
      setPicksLoading(true);
    }
    setPicksError('');
    try {
      const data = await getBettingPicks(refresh);
      setPicks(data);
      // an empty slate isn't worth pinning in the cache — re-ask next visit.
      if (!data.no_games && data.picks.length > 0) {
        setCachedBettingPicks(data);
      }
    } catch {
      setPicksError('Failed to load AI picks');
    } finally {
      setPicksLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    reloadOdds();
  }, [reloadOdds]);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (initialPicks) return; // hydrated from cache — skip the round trip
    void reloadPicks();
  }, [isLoggedIn, initialPicks, reloadPicks]);

  return {
    odds,
    oddsLoading,
    oddsError,
    reloadOdds,
    picks,
    picksLoading,
    refreshing,
    picksError,
    reloadPicks,
  };
}
