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
  name_is_placeholder: false,
  team_abbr: 'OKC',
  opponent_team_abbr: 'LAL',
  nba_game_id: '0022500555',
  game_date: '2026-02-04',
  score: 1.42,
  upside: 1.6,
  drivers: [
    { stat: 'minutes', delta: 9, scaled: 2.1 },
    { stat: 'pts', delta: 8.4, scaled: 1.9 },
  ],
  relevance: 0.89,
  impact: 3.4,
  impact_percentile: 96.7,
  prob_active: 0.88,
  minutes: { usual: 22, projected: 31, delta: 9 },
  points: { usual: 11.6, projected: 20, delta: 8.4 },
  baseline_games: 15,
  reasons: ['ROLE_INCREASE', 'TEAMMATE_ABSENCE'],
  evidence: {
    teammate_out: 'Franchise Player',
    teammate_out_minutes: 34.6,
    teammate_out_prob_active: 0.12,
  },
};

const returnee: WatchlistPlayer = {
  nba_player_id: '2544',
  name: 'Returning Vet',
  name_is_placeholder: false,
  team_abbr: 'LAL',
  opponent_team_abbr: 'OKC',
  nba_game_id: '0022500555',
  game_date: '2026-02-04',
  score: 0.31,
  upside: 0.62,
  drivers: [{ stat: 'reb', delta: 1.4, scaled: 0.8 }],
  relevance: 0.5,
  impact: 0.9,
  impact_percentile: 85,
  prob_active: null,
  minutes: { usual: 24, projected: 25.5, delta: 1.5 },
  points: { usual: 15, projected: 15.4, delta: 0.4 },
  baseline_games: 11,
  reasons: ['RETURNING_FROM_ABSENCE'],
  evidence: { days_since_played: 9, last_played_date: '2026-01-26' },
};

function payload(overrides: Partial<WatchlistResponse> = {}): WatchlistResponse {
  return {
    date: '2026-02-04',
    run: { model_version: 'v1-decomposed', predicted_at: '2026-02-04T11:00:00Z' },
    pool: {
      key: 'slate',
      label: "Tonight's slate",
      definition: "every player the run projects for this date, across all of the date's games",
      sample_size: 244,
    },
    baseline: {
      window_games: 15,
      min_games: 5,
      notable_min_delta: 4,
      label: 'his own recent form',
      definition: 'per-game averages over his last 15 games played before this date',
    },
    players: [breakout, returnee],
    ...overrides,
  };
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
    expect(screen.getByText('1.42')).toBeInTheDocument();
    expect(screen.getByText('0.31')).toBeInTheDocument();
  });

  it('leads each row with the minutes it is claiming will change', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert — the deltas are the claim; the score is only the ordering. The
    // arrow sits in its own span, so the row is read as text rather than matched.
    const minutes = screen.getByTitle(/He averages 22\.0 minutes/);
    expect(minutes.textContent?.replace(/\s+/g, ' ')).toBe('22 → 31 min');
    expect(screen.getByText(/\+8\.4 pts vs usual/)).toBeInTheDocument();
  });

  it('names the team and the opponent', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const row = screen.getByText('Breakout Wing').closest('li') as HTMLElement;
    expect(within(row).getByText(/OKC/)).toBeInTheDocument();
    expect(within(row).getByText(/LAL/)).toBeInTheDocument();
  });

  it('lists the categories pulling the score up', async () => {
    // arrange + act — without these, a positive score on flat minutes reads as a
    // contradiction
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.getByText(/up vs usual: MIN \+9\.0 · PTS \+8\.4/)).toBeInTheDocument();
    expect(screen.getByText(/up vs usual: REB \+1\.4/)).toBeInTheDocument();
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
    expect(screen.getByText(/at least 4 above his recent average/i)).toBeInTheDocument();
    expect(screen.getByText(/2\.5 more field goal attempts/i)).toBeInTheDocument();
    expect(screen.getByText(/7 to 45 days/i)).toBeInTheDocument();
    expect(screen.getByText(/1\.5 of his own standard deviations/i)).toBeInTheDocument();
    expect(screen.getByText(/usually plays 28\+ minutes is unlikely to appear/i)).toBeInTheDocument();
  });

  it('says the badges explain the ranking rather than being it', async () => {
    // arrange + act
    renderPage();
    await screen.findByRole('heading', { name: /What the badges mean/i });

    // assert
    expect(screen.getByText(/Badges explain a row; they do not rank it/i)).toBeInTheDocument();
    expect(screen.getByText(/tripling his minutes scores nothing/i)).toBeInTheDocument();
  });

  it('shows the evidence behind the reasons that fired, and the absolute floor', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const evidence = screen.getByTestId('evidence-1630559');
    expect(
      within(evidence).getByText(/31\.0 projected against a 22\.0 average over his last 15 games/)
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText(/Franchise Player usually plays 34\.6 minutes, 12% to play/)
    ).toBeInTheDocument();
    expect(within(evidence).getByText(/97th percentile of the slate/)).toBeInTheDocument();
    // the return evidence belongs to the other player only
    expect(within(evidence).queryByText(/days without a game/)).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('evidence-2544')).getByText(
        /9 days without a game, last played 2026-01-26/
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

  it('shows availability with the same wording as a player upcoming-games table', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByText('No estimate')).toBeInTheDocument();
  });

  it('shows the projected total impact alongside the score', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert — the same number the Projections tab ranks by
    expect(screen.getByText('+3.4')).toBeInTheDocument();
  });

  it('renders a placeholder name as an id rather than as a person', async () => {
    // arrange
    watchlistMock.mockResolvedValue(
      payload({
        players: [
          {
            ...breakout,
            nba_player_id: '1642850',
            name: 'NBA #1642850 (new roster)',
            name_is_placeholder: true,
            team_abbr: null,
            opponent_team_abbr: null,
          },
        ],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText('NBA #1642850 (new roster)')).toBeInTheDocument();
    expect(
      screen.getByTitle(/no roster row yet, so only his NBA id is known/i)
    ).toBeInTheDocument();
  });

  it('explains that the page needs a run, because it compares against a baseline', async () => {
    // arrange
    watchlistMock.mockResolvedValue(payload({ run: null, players: [] }));

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/No prediction run yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to rank until a run completes/i)).toBeInTheDocument();
  });

  it('drops the notice once a run has scored the date', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByText('Breakout Wing')).toBeInTheDocument();
    expect(screen.queryByText(/No prediction run yet/i)).not.toBeInTheDocument();
  });

  it('calls an empty list a normal answer, and points at the projections', async () => {
    // arrange — a run exists; nobody clears both terms
    watchlistMock.mockResolvedValue(payload({ players: [] }));

    // act
    renderPage();

    // assert
    expect(
      await screen.findByText('Nobody is projected above their own usual tonight')
    ).toBeInTheDocument();
    expect(screen.getByText(/That is a normal answer/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /The projections/i })).toHaveAttribute(
      'href',
      '/projections'
    );
    expect(screen.getByRole('heading', { name: /What the badges mean/i })).toBeInTheDocument();
  });

  it('describes the baseline and the pool the server used, never its own', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.getByText(/his own recent form/i)).toBeInTheDocument();
    expect(screen.getByText(/last 15 games played before this date/i)).toBeInTheDocument();
    expect(screen.getByText(/every player the run projects for this date/i)).toBeInTheDocument();
    expect(screen.getByText(/244 players/)).toBeInTheDocument();
  });

  it('refetches for another date when the picker changes', async () => {
    // arrange
    renderPage();
    await screen.findByText('Breakout Wing');
    watchlistMock.mockResolvedValue(payload({ date: '2026-02-06', players: [] }));

    // act — a date input is set wholesale, not typed character by character
    fireEvent.change(screen.getByLabelText('As-of date'), { target: { value: '2026-02-06' } });

    // assert
    expect(
      await screen.findByText('Nobody is projected above their own usual tonight')
    ).toBeInTheDocument();
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
