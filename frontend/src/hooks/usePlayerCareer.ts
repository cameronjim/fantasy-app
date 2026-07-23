import { useEffect, useState } from 'react';
import { getPlayerCareer } from '../api/client';
import type { PlayerSeasonRow } from '../types';

export interface PlayerCareer {
  seasons: PlayerSeasonRow[];
  loading: boolean;
  // true when the lookup failed or the player simply has no ingested history;
  // callers render nothing extra in both cases.
  unavailable: boolean;
}

/**
 * Loads a player's season-by-season history. `nbaPlayerId` is nullable because
 * seeded players predate the scraper and have no stats.nba.com id — for those
 * the hook stays idle instead of firing a request that can only 404.
 */
export function usePlayerCareer(nbaPlayerId: string | null | undefined): PlayerCareer {
  const [seasons, setSeasons] = useState<PlayerSeasonRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSeasons([]);
    setFailed(false);
    if (!nbaPlayerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getPlayerCareer(nbaPlayerId)
      .then((career) => {
        if (!cancelled) setSeasons(career.seasons);
      })
      .catch(() => {
        // a missing career is the normal case until the backfill runs, so it
        // collapses the section rather than surfacing an error to the user.
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nbaPlayerId]);

  return {
    seasons,
    loading,
    unavailable: !nbaPlayerId || failed || (!loading && seasons.length === 0),
  };
}
