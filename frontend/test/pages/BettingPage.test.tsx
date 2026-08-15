import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BettingPage } from '../../src/pages/BettingPage';

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    getBettingOdds: vi.fn(),
    getBettingPicks: vi.fn(),
    getBets: vi.fn(),
    getPreferences: vi.fn(),
  };
});

const { getBettingOdds, getBettingPicks, getBets, getPreferences } = await import('../../src/api/client');
const oddsMock = vi.mocked(getBettingOdds);
const picksMock = vi.mocked(getBettingPicks);
const betsMock = vi.mocked(getBets);
const prefsMock = vi.mocked(getPreferences);

beforeEach(() => {
  vi.clearAllMocks();
  oddsMock.mockResolvedValue({ games: [], fetched_at: '2026-06-09T12:00:00Z' });
  picksMock.mockResolvedValue({ picks: [], parlay: null, summary: '', no_games: true });
  betsMock.mockResolvedValue({
    bets: [],
    summary: { wins: 0, losses: 0, pushes: 0, pending: 0, net: 0 },
  });
  prefsMock.mockResolvedValue({});
});

describe('BettingPage', () => {
  it('shows the responsible-gambling footer without the old banner', async () => {
    render(<BettingPage isLoggedIn={false} />);

    expect(await screen.findByText(/1-800-GAMBLER/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the sign-in prompt, odds board, chat, and glossary when logged out', async () => {
    render(<BettingPage isLoggedIn={false} />);

    expect(await screen.findByText(/Sign in to unlock AI betting picks/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Upcoming Games & Odds/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /New to betting\? Start here/i })).toBeInTheDocument();
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    expect(picksMock).not.toHaveBeenCalled();
    expect(betsMock).not.toHaveBeenCalled();
  });

  it('loads picks, ledger, and prefs when logged in', async () => {
    render(<BettingPage isLoggedIn={true} />);

    expect(await screen.findByText(/No bettable games right now/i)).toBeInTheDocument();
    expect(picksMock).toHaveBeenCalled();
    expect(betsMock).toHaveBeenCalled();
    expect(screen.getByText('Betting Preferences')).toBeInTheDocument();
  });

  it('shows the odds error state with a retry button', async () => {
    oddsMock.mockRejectedValue(new Error('espn down'));

    render(<BettingPage isLoggedIn={false} />);

    expect(await screen.findByText(/Failed to load odds/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });
});
