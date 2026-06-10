import { useCallback, useEffect, useState } from 'react';
import { getBets, createBet, deleteBet, settleBetStatus } from '../api/client';
import type { Bet, BetStatus, LedgerSummary, NewBet } from '../types';

const EMPTY_SUMMARY: LedgerSummary = { wins: 0, losses: 0, pushes: 0, pending: 0 };

interface UseBetLedger {
  bets: Bet[];
  summary: LedgerSummary;
  loading: boolean;
  error: string;
  trackBet: (bet: NewBet) => Promise<void>;
  settleBet: (id: number, status: BetStatus) => Promise<void>;
  removeBet: (id: number) => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * The user's bet ledger. Mutations re-fetch the whole ledger instead of
 * patching local state — straight bets settle server-side on read, so the
 * server is the only source of truth for status and record.
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

  const settleBet = useCallback(async (id: number, status: BetStatus): Promise<void> => {
    await settleBetStatus(id, status);
    await reload();
  }, [reload]);

  const removeBet = useCallback(async (id: number): Promise<void> => {
    await deleteBet(id);
    await reload();
  }, [reload]);

  return { bets, summary, loading, error, trackBet, settleBet, removeBet, reload };
}
