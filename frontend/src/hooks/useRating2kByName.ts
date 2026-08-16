import { useEffect, useState } from 'react';
import { getRatings2kByName } from '../api/client';
import type { Rating2kSummary } from '../types';

export interface Rating2kMatch {
  rating: Rating2kSummary | null;
  loading: boolean;
  // true when there is no match, or the lookup failed — callers render nothing
  // extra in both cases, because 2K coverage is name-based and incomplete.
  unavailable: boolean;
}

/**
 * Resolves one of our players to their 2K row by name. Misses are the normal
 * case (2K publishes no NBA ids), so a failure collapses the surface instead of
 * showing an error.
 */
export function useRating2kByName(name: string | null | undefined): Rating2kMatch {
  const [rating, setRating] = useState<Rating2kSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setRating(null);
    setFailed(false);
    if (!name) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getRatings2kByName(name)
      .then((match) => {
        if (!cancelled) setRating(match);
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
  }, [name]);

  return { rating, loading, unavailable: !name || failed || (!loading && rating === null) };
}
