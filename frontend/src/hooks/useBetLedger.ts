import { useCallback, useEffect, useState } from 'react';
import { getBets, createBet, deleteBet } from '../api/client';
import type { Bet, LedgerSummary, NewBet } from '../types';

const EMPTY_SUMMARY: LedgerSummary = {
  wins: 0, losses: 0, pushes: 0, pending: 0, total_staked: 0, profit: 0, roi: 0,
};

interface UseBetLedger {
  bets: Bet[];
  summary: LedgerSummary;
  loading: boolean;
  error: string;
  trackBet: (bet: NewBet) => Promise<void>;
  removeBet: (id: number) => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * The user's bet ledger. Mutations re-fetch the whole ledger instead of
 * patching local state — settlement happens server-side on read, so the
 * server is the only source of truth for status/profit/summary.
 */
export function useBetLedger(isLoggedIn: boolean): UseBetLedger {
  const [bets, setBets] = useState<Bet[]>([]);
  const [summary, setSummary] = useState<LedgerSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const data = await getBets();
      setBets(data.bets);
      setSummary(data.summary);
    } catch {
      setError('Failed to load your bets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    void reload();
  }, [isLoggedIn, reload]);

  const trackBet = useCallback(async (bet: NewBet): Promise<void> => {
    await createBet(bet);
    await reload();
  }, [reload]);

  const removeBet = useCallback(async (id: number): Promise<void> => {
    await deleteBet(id);
    await reload();
  }, [reload]);

  return { bets, summary, loading, error, trackBet, removeBet, reload };
}
