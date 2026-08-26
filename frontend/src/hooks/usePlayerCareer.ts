import { useEffect, useState } from 'react';
import { getPlayerCareer } from '../api/client';
import type { PlayerSeasonRow } from '../types';

export interface PlayerCareer {
  seasons: PlayerSeasonRow[];
  loading: boolean;
  unavailable: boolean;
}

// seeded players have no stats.nba.com id, so a null id must stay idle rather than request a 404.
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
