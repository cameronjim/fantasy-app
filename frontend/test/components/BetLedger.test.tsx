import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BetLedger } from '../../src/components/BetLedger';
import type { Bet, LedgerSummary } from '../../src/types';

const summary: LedgerSummary = {
  wins: 2,
  losses: 1,
  pushes: 0,
  pending: 1,
  total_staked: 175,
  profit: 62.5,
  roi: 0.4167,
};

const bets: Bet[] = [
  {
    id: 1, nba_game_id: '401', home_team: 'New York Knicks', away_team: 'San Antonio Spurs',
    game_date: '2026-06-10', market: 'spread', selection: 'home', line: -2.5,
    american_odds: -105, stake: 50, status: 'won',
    created_at: '2026-06-09T12:00:00Z', settled_at: '2026-06-11T03:00:00Z', profit: 47.62,
  },
  {
    id: 2, nba_game_id: '402', home_team: 'Boston Celtics', away_team: 'Miami Heat',
    game_date: '2026-06-11', market: 'total', selection: 'under', line: 216.5,
    american_odds: -108, stake: 25, status: 'pending',
    created_at: '2026-06-09T13:00:00Z', settled_at: null, profit: 0,
  },
];

const noopTrack = (): Promise<void> => Promise.resolve();
const noopRemove = (): Promise<void> => Promise.resolve();

describe('BetLedger', () => {
  it('renders the record, staked, profit, and roi stats', () => {
    render(
      <BetLedger
        bets={bets}
        summary={summary}
        loading={false}
        error=""
        games={[]}
        onTrackBet={noopTrack}
        onRemoveBet={noopRemove}
      />
    );

    expect(screen.getByText('2-1')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByText('$175.00')).toBeInTheDocument();
    expect(screen.getByText('$62.50')).toBeInTheDocument();
    expect(screen.getByText('41.7%')).toBeInTheDocument();
  });

  it('labels bets in plain english and badges their status', () => {
    render(
      <BetLedger
        bets={bets}
        summary={summary}
        loading={false}
        error=""
        games={[]}
        onTrackBet={noopTrack}
        onRemoveBet={noopRemove}
      />
    );

    expect(screen.getByText('New York Knicks -2.5')).toBeInTheDocument();
    expect(screen.getByText('Under 216.5')).toBeInTheDocument();
    expect(screen.getByText('won')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('shows the empty state when no bets are tracked', () => {
    render(
      <BetLedger
        bets={[]}
        summary={{ wins: 0, losses: 0, pushes: 0, pending: 0, total_staked: 0, profit: 0, roi: 0 }}
        loading={false}
        error=""
        games={[]}
        onTrackBet={noopTrack}
        onRemoveBet={noopRemove}
      />
    );

    expect(screen.getByText(/No bets tracked yet/i)).toBeInTheDocument();
  });

  it('calls onRemoveBet when the delete button is clicked', async () => {
    const onRemoveBet = vi.fn().mockResolvedValue(undefined);
    render(
      <BetLedger
        bets={bets}
        summary={summary}
        loading={false}
        error=""
        games={[]}
        onTrackBet={noopTrack}
        onRemoveBet={onRemoveBet}
      />
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Delete bet on New York Knicks -2\.5/i }));

    expect(onRemoveBet).toHaveBeenCalledWith(1);
  });
});
