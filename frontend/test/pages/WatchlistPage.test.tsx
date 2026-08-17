import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WatchlistPage } from '../../src/pages/WatchlistPage';
import type { WatchlistPlayer, WatchlistResponse } from '../../src/types';

// mock the api boundary — these tests exercise the page's branches, not http.
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return { ...actual, getWatchlist: vi.fn() };
});

const { getWatchlist } = await import('../../src/api/client');
const watchlistMock = vi.mocked(getWatchlist);

const breakout: WatchlistPlayer = {
  nba_player_id: '1630559',
  name: 'Breakout Wing',
  team_abbr: 'OKC',
  score: 6.6,
  prob_active: 0.88,
  reasons: ['ROLE_INCREASE', 'TEAMMATE_ABSENCE'],
  evidence: {
    min_r5: 30.2,
    min_r15: 22,
    min_delta: 8.2,
    teammate_out: 'Franchise Player',
    teammate_out_minutes: 34.6,
  },
};

const returnee: WatchlistPlayer = {
  nba_player_id: '2544',
  name: 'Returning Vet',
  team_abbr: 'LAL',
  score: 1.5,
  prob_active: null,
  reasons: ['RETURNING_FROM_ABSENCE'],
  evidence: { gap_days: 9, last_game_date: '2026-02-03' },
};

function payload(overrides: Partial<WatchlistResponse> = {}): WatchlistResponse {
  return { date: '2026-02-04', players: [breakout, returnee], ...overrides };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/watchlist']}>
      <WatchlistPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  watchlistMock.mockResolvedValue(payload());
});

describe('WatchlistPage', () => {
  it('renders the ranked candidates with their scores', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByText('Breakout Wing')).toBeInTheDocument();
    expect(screen.getByText('Returning Vet')).toBeInTheDocument();
    expect(screen.getByText('6.6')).toBeInTheDocument();
    expect(screen.getByText('1.5')).toBeInTheDocument();
    expect(screen.getByText('OKC')).toBeInTheDocument();
  });

  it('keeps the server ranking and numbers the rows from it', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const rows = screen.getAllByRole('listitem').filter((row) => row.querySelector('details'));
    expect(within(rows[0]).getByText('Breakout Wing')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Returning Vet')).toBeInTheDocument();
    expect(within(rows[1]).getByText('2')).toBeInTheDocument();
  });

  it('labels each reason code as a badge', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert — once on the row and once in the legend
    expect(screen.getAllByText('Role increase').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Teammate out').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Just back').length).toBeGreaterThanOrEqual(2);
  });

  it('explains every reason code in the legend, including unused ones', async () => {
    // arrange + act
    renderPage();
    await screen.findByRole('heading', { name: /What the badges mean/i });

    // assert — the legend documents the full rule set, not just what fired
    expect(screen.getByText(/at least 4 more minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/2\.5 more field goal attempts/i)).toBeInTheDocument();
    expect(screen.getByText(/gap of 7 or more days/i)).toBeInTheDocument();
    expect(screen.getByText(/1\.5 of the player's own standard deviations/i)).toBeInTheDocument();
    expect(screen.getByText(/averaging 28\+ minutes is ruled Out/i)).toBeInTheDocument();
  });

  it('shows the evidence numbers behind the reasons that fired', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const evidence = screen.getByTestId('evidence-1630559');
    expect(within(evidence).getByText(/30\.2 over the last 5 vs 22\.0 over the last 15/)).toBeInTheDocument();
    expect(within(evidence).getByText(/Franchise Player \(34\.6 minutes per game\)/)).toBeInTheDocument();
    // the return evidence belongs to the other player only
    expect(within(evidence).queryByText(/days between appearances/)).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('evidence-2544')).getByText(
        /9 days between appearances, returned 2026-02-03/
      )
    ).toBeInTheDocument();
  });

  it('opens a candidate row to reveal its evidence', async () => {
    // arrange
    renderPage();
    await screen.findByText('Breakout Wing');
    const user = userEvent.setup();
    const details = screen.getByTestId('evidence-1630559').closest('details');

    // act
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    await user.click(screen.getByText('Breakout Wing'));

    // assert
    expect(details).toHaveAttribute('open');
  });

  it('shows the availability percentage, and says so when no run has scored the date', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByText('no run')).toBeInTheDocument();
  });

  it('warns that the ranking is rules-only when nothing has a projection', async () => {
    // arrange
    watchlistMock.mockResolvedValue(payload({ players: [returnee] }));

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/No prediction run yet/i)).toBeInTheDocument();
    expect(screen.getByText(/rules alone, without availability/i)).toBeInTheDocument();
  });

  it('drops the warning once a run has scored the candidates', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByText('Breakout Wing')).toBeInTheDocument();
    expect(screen.queryByText(/No prediction run yet/i)).not.toBeInTheDocument();
  });

  it('shows an empty state on a quiet day, with the legend still visible', async () => {
    // arrange
    watchlistMock.mockResolvedValue(payload({ players: [] }));

    // act
    renderPage();

    // assert
    expect(await screen.findByText('Nothing on the wire today')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /What the badges mean/i })).toBeInTheDocument();
    expect(screen.queryByText(/No prediction run yet/i)).not.toBeInTheDocument();
  });

  it('refetches for another date when the picker changes', async () => {
    // arrange
    renderPage();
    await screen.findByText('Breakout Wing');
    watchlistMock.mockResolvedValue(payload({ date: '2026-02-06', players: [] }));

    // act — a date input is set wholesale, not typed character by character
    fireEvent.change(screen.getByLabelText('As-of date'), { target: { value: '2026-02-06' } });

    // assert
    expect(await screen.findByText('Nothing on the wire today')).toBeInTheDocument();
    expect(watchlistMock).toHaveBeenLastCalledWith('2026-02-06');
  });

  it('shows an error state with a retry button when the request fails', async () => {
    // arrange
    watchlistMock.mockRejectedValue(new Error('watchlist down'));

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/Failed to load the watchlist/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });
});
