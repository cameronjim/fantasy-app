import { useCallback, useEffect, useState } from 'react';
import { getRatings2kPlayer } from '../api/client';
import type { Rating2kDetail } from '../types';

export interface Rating2kDetailState {
  detail: Rating2kDetail | null;
  loading: boolean;
  error: string;
  notFound: boolean;
  reload: () => void;
}

export function useRating2kDetail(slug: string): Rating2kDetailState {
  const [detail, setDetail] = useState<Rating2kDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback((): void => {
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setNotFound(false);

    getRatings2kPlayer(slug)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setNotFound(result === null);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load 2K ratings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  return { detail, loading, error, notFound, reload };
}
