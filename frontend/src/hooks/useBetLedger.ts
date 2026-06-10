import { useCallback, useEffect, useRef, useState } from 'react';
import { getBets, createBet, deleteBet, settleBetStatus } from '../api/client';
import type { Bet, BetStatus, LedgerSummary, NewBet, NewBetGameRef } from '../types';

const EMPTY_SUMMARY: LedgerSummary = { wins: 0, losses: 0, pushes: 0, pending: 0, net: 0 };

interface UseBetLedger {
  bets: Bet[];
  summary: LedgerSummary;
  loading: boolean;
  error: string;
  trackBet: (bet: NewBet, gameRef?: NewBetGameRef) => Promise<void>;
  settleBet: (id: number, status: BetStatus) => Promise<void>;
  removeBet: (id: number) => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * The user's bet ledger, with optimistic mutations: add/settle/delete apply
 * to local state immediately so the UI never stalls on a round trip, then
 * the API call runs in the background and reverts the change (with an error
 * message) if it fails. Server-computed fields (net, real ids) reconcile via
 * the API response or a silent re-fetch.
 */
export function useBetLedger(isLoggedIn: boolean): UseBetLedger {
  const [bets, setBets] = useState<Bet[]>([]);
  const [summary, setSummary] = useState<LedgerSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // temp ids for optimistic rows are negative so they can never collide with
  // real SERIAL ids from the db.
  const tempIdRef = useRef(-1);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = await getBets();
      setBets(data.bets);
      setSummary(data.summary);
    } catch {
      if (!silent) setError('Failed to load your bets');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    void reload();
  }, [isLoggedIn, reload]);

  const trackBet = useCallback(async (bet: NewBet, gameRef?: NewBetGameRef): Promise<void> => {
    const tempId = tempIdRef.current--;
    const temp: Bet = {
      id: tempId,
      market: bet.market,
      nba_game_id: bet.nba_game_id ?? null,
      home_team: gameRef?.home_team ?? null,
      away_team: gameRef?.away_team ?? null,
      game_date: gameRef?.game_date ?? null,
      selection: bet.selection ?? null,
      line: bet.line ?? null,
      american_odds: bet.american_odds ?? null,
      description: bet.description ?? null,
      stake: bet.stake,
      wager_type: bet.wager_type ?? 'cash',
      status: 'pending',
      created_at: new Date().toISOString(),
      settled_at: null,
      net: null,
    };
    setError('');
    setBets((prev) => [temp, ...prev]);
    setSummary((s) => ({ ...s, pending: s.pending + 1 }));

    void createBet(bet)
      .then((saved) => {
        setBets((prev) => prev.map((b) => (b.id === tempId ? saved : b)));
      })
      .catch(() => {
        setBets((prev) => prev.filter((b) => b.id !== tempId));
        setSummary((s) => ({ ...s, pending: s.pending - 1 }));
        setError("Couldn't save that bet, so it was removed from the list. Try again.");
      });
  }, []);

  const settleBet = useCallback(async (id: number, status: BetStatus): Promise<void> => {
    const prevBets = bets;
    const prevSummary = summary;
    setError('');
    setBets((prev) =>
      prev.map((b) => (b.id === id ? { ...b, status, settled_at: new Date().toISOString() } : b))
    );
    setSummary((s) => ({
      ...s,
      pending: s.pending - 1,
      wins: s.wins + (status === 'won' ? 1 : 0),
      losses: s.losses + (status === 'lost' ? 1 : 0),
      pushes: s.pushes + (status === 'push' ? 1 : 0),
    }));

    try {
      await settleBetStatus(id, status);
      // the server computes the money result — pick it up quietly.
      void reload(true);
    } catch {
      setBets(prevBets);
      setSummary(prevSummary);
      setError("Couldn't settle that bet. Try again.");
    }
  }, [bets, summary, reload]);

  const removeBet = useCallback(async (id: number): Promise<void> => {
    const prevBets = bets;
    const prevSummary = summary;
    const bet = bets.find((b) => b.id === id);
    if (!bet) return;
    setError('');
    setBets((prev) => prev.filter((b) => b.id !== id));
    setSummary((s) => ({
      wins: s.wins - (bet.status === 'won' ? 1 : 0),
      losses: s.losses - (bet.status === 'lost' ? 1 : 0),
      pushes: s.pushes - (bet.status === 'push' ? 1 : 0),
      pending: s.pending - (bet.status === 'pending' ? 1 : 0),
      net: Math.round((s.net - (bet.net ?? 0)) * 100) / 100,
    }));

    try {
      await deleteBet(id);
    } catch {
      setBets(prevBets);
      setSummary(prevSummary);
      setError("Couldn't delete that bet, so it was restored. Try again.");
    }
  }, [bets, summary]);

  return { bets, summary, loading, error, trackBet, settleBet, removeBet, reload };
}
