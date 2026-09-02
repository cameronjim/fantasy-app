import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../../src/pages/HomePage';

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    getPlayers: vi.fn(),
    getTeams: vi.fn(),
    getGames: vi.fn(),
    getLiveGames: vi.fn(),
  };
});

const { getPlayers, getTeams, getGames, getLiveGames } = await import('../../src/api/client');
const playersMock = vi.mocked(getPlayers);
const teamsMock = vi.mocked(getTeams);
const gamesMock = vi.mocked(getGames);
const liveGamesMock = vi.mocked(getLiveGames);

function renderHome(isLoggedIn: boolean) {
  return render(
    <MemoryRouter>
      <HomePage isLoggedIn={isLoggedIn} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  playersMock.mockResolvedValue([]);
  teamsMock.mockResolvedValue([]);
  gamesMock.mockResolvedValue([]);
  liveGamesMock.mockResolvedValue([]);
});

describe('HomePage', () => {
  it('renders the eight destination cards with their links', () => {
    renderHome(true);

    const cards: Array<[string, string]> = [
      ['Stats', '/stats'],
      ['Projections', '/projections'],
      ['Watchlist', '/watchlist'],
      ['History', '/history'],
      ['2K Ratings', '/ratings'],
      ['My Team', '/fantasy'],
      ['Improve Team', '/improve'],
      ['Betting', '/betting'],
    ];

    for (const [title, to] of cards) {
      const link = screen.getByRole('link', { name: new RegExp(title) });
      expect(link).toHaveAttribute('href', to);
    }
  });

  it('shows the sign-in prompt when logged out', () => {
    renderHome(false);

    expect(
      screen.getByText(/Sign in to track your fantasy roster, get waiver suggestions, and keep a bet ledger\./)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('hides the sign-in prompt when logged in', () => {
    renderHome(true);

    expect(
      screen.queryByText(/Sign in to track your fantasy roster/)
    ).not.toBeInTheDocument();
  });

  it('prefetches players and teams on mount', () => {
    renderHome(true);

    expect(playersMock).toHaveBeenCalled();
    expect(teamsMock).toHaveBeenCalled();
  });
});
