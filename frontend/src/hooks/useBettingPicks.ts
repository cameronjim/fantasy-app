import { useCallback, useEffect, useState } from 'react';
import { getBettingOdds, getBettingPicks } from '../api/client';
import {
  getCachedBettingPicks,
  setCachedBettingPicks,
  invalidateBettingClientCache,
} from '../api/clientCaches';
import { useCachedResource } from './useCachedResource';
import { CACHE_KEYS } from '../api/resourceCache';
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
 * users. Both render instantly from cache on tab switches; when the server
 * reports the picks are stale (lines moved), the previous picks stay on
 * screen while a regeneration runs in the background.
 */
export function useBettingPicks(isLoggedIn: boolean): UseBettingPicks {
  const [initialPicks] = useState(() => (isLoggedIn ? getCachedBettingPicks() : null));

  const {
    data: oddsData,
    loading: oddsLoading,
    error: oddsError,
    reload: reloadOddsResource,
  } = useCachedResource(CACHE_KEYS.odds, getBettingOdds, {
    errorMessage: 'Failed to load odds. ESPN may be unavailable. Try again in a minute.',
  });
  const odds = oddsData?.games ?? [];
  const reloadOdds = useCallback((): void => {
    void reloadOddsResource();
  }, [reloadOddsResource]);

  const [picks, setPicks] = useState<BettingPicksResponse | null>(initialPicks);
  const [picksLoading, setPicksLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [picksError, setPicksError] = useState('');

  const reloadPicks = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) {
      invalidateBettingClientCache();
      setRefreshing(true);
    } else {
      setPicksLoading(true);
    }
    setPicksError('');
    let data: BettingPicksResponse;
    try {
      data = await getBettingPicks(refresh);
    } catch {
      setPicksError('Failed to load AI picks');
      setPicksLoading(false);
      setRefreshing(false);
      return;
    }
    setPicks(data);
    // an empty slate isn't worth pinning, and a stale response is about to
    // be replaced by the background regeneration below — cache neither.
    if (!data.no_games && data.picks.length > 0 && !data.stale) {
      setCachedBettingPicks(data);
    }
    setPicksLoading(false);
    if (!refresh && data.stale) {
      // lines moved since these picks were generated — they're already on
      // screen, so regenerate behind the scenes and swap when ready.
      setRefreshing(true);
      try {
        const fresh = await getBettingPicks(true);
        setPicks(fresh);
        if (!fresh.no_games && fresh.picks.length > 0) {
          setCachedBettingPicks(fresh);
        }
      } catch {
        // regeneration failed — the previous picks stay visible.
      }
    }
    setRefreshing(false);
  }, []);

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
