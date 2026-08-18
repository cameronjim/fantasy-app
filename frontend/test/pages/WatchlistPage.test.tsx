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
  position: 'SG/SF',
  opponent_team_abbr: 'LAL',
  nba_game_id: '0022500555',
  game_date: '2026-02-04',
  games_count: 1,
  games: [
    {
      game_date: '2026-02-04',
      nba_game_id: '0022500555',
      opponent_team_abbr: 'LAL',
      minutes_p50: 31,
      proj_pts: 20,
      impact: 3.4,
      score: 1.42,
    },
  ],
  score: 1.42,
  score_per_game: 1.42,
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
  totals: { pts: 20 },
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
  position: 'C',
  opponent_team_abbr: 'OKC',
  nba_game_id: '0022500555',
  game_date: '2026-02-04',
  games_count: 1,
  games: [
    {
      game_date: '2026-02-04',
      nba_game_id: '0022500555',
      opponent_team_abbr: 'OKC',
      minutes_p50: 25.5,
      proj_pts: 15.4,
      impact: 0.9,
      score: 0.31,
    },
  ],
  score: 0.31,
  score_per_game: 0.31,
  upside: 0.62,
  drivers: [{ stat: 'reb', delta: 1.4, scaled: 0.8 }],
  relevance: 0.5,
  impact: 0.9,
  impact_percentile: 85,
  prob_active: null,
  minutes: { usual: 24, projected: 25.5, delta: 1.5 },
  points: { usual: 15, projected: 15.4, delta: 0.4 },
  totals: { pts: 15.4 },
  baseline_games: 11,
  reasons: ['RETURNING_FROM_ABSENCE'],
  evidence: { days_since_played: 9, last_played_date: '2026-01-26' },
};

/**
 * A four-game week for the same player: the streaming case the window exists
 * for. His per-game score is LOWER than the one-night `breakout` row, and his
 * total is higher, which is the claim the page has to be able to make.
 */
const weekLong: WatchlistPlayer = {
  ...breakout,
  games_count: 4,
  score: 2.4,
  score_per_game: 0.6,
  impact: 11.2,
  games: [
    {
      game_date: '2026-02-04',
      nba_game_id: '0022500555',
      opponent_team_abbr: 'LAL',
      minutes_p50: 31,
      proj_pts: 20,
      impact: 3.4,
      score: 0.9,
    },
    {
      game_date: '2026-02-05',
      nba_game_id: '0022500601',
      opponent_team_abbr: 'DEN',
      minutes_p50: 29,
      proj_pts: 18.2,
      impact: 2.8,
      score: 0.7,
    },
    {
      game_date: '2026-02-07',
      nba_game_id: '0022500612',
      opponent_team_abbr: 'PHX',
      minutes_p50: 30,
      proj_pts: 19,
      impact: 2.9,
      score: 0.8,
    },
    {
      game_date: '2026-02-09',
      nba_game_id: '0022500620',
      opponent_team_abbr: 'SAC',
      minutes_p50: 24,
      proj_pts: 12.1,
      impact: 2.1,
      score: 0,
    },
  ],
  totals: { pts: 69.3 },
};

function payload(overrides: Partial<WatchlistResponse> = {}): WatchlistResponse {
  return {
    date: '2026-02-04',
    window: { from: '2026-02-04', to: '2026-02-04', days: 1 },
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
    position: null,
    position_options: ['G', 'F', 'C', 'PG', 'SG', 'SF', 'PF'],
    position_coverage: { known: 244, unknown: 0 },
    players: [breakout, returnee],
    ...overrides,
  };
}

/** The same payload as a seven-day window. */
function weekPayload(overrides: Partial<WatchlistResponse> = {}): WatchlistResponse {
  return payload({
    window: { from: '2026-02-04', to: '2026-02-10', days: 7 },
    pool: {
      key: 'slate',
      label: "Each night's slate",
      definition:
        "every player the run projects for a date, across all of that date's games — each night in the window is scored against its own slate",
      sample_size: 1712,
    },
    players: [weekLong],
    ...overrides,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/watchlist']}>
      <WatchlistPage />
    </MemoryRouter>
  );
}

/**
 * The window and position arguments of the last request. The date argument is
 * the real today in Eastern — the page's own default — so asserting on it would
 * make these tests fail tomorrow.
 */
function lastRequestWindow(): unknown[] {
  return (watchlistMock.mock.calls.at(-1) ?? []).slice(1);
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
    expect(screen.getByText(/244 player-games/)).toBeInTheDocument();
  });

  it('refetches for another date when the picker changes', async () => {
    // arrange
    renderPage();
    await screen.findByText('Breakout Wing');
    watchlistMock.mockResolvedValue(payload({ date: '2026-02-06', players: [] }));

    // act — a date input is set wholesale, not typed character by character
    fireEvent.change(screen.getByLabelText('Window start date'), {
      target: { value: '2026-02-06' },
    });

    // assert
    expect(
      await screen.findByText('Nobody is projected above their own usual tonight')
    ).toBeInTheDocument();
    expect(watchlistMock).toHaveBeenLastCalledWith('2026-02-06', 1, null);
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

  it('shows each position next to the name', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const row = screen.getByText('Breakout Wing').closest('li') as HTMLElement;
    expect(within(row).getByText('SG/SF')).toBeInTheDocument();
    const other = screen.getByText('Returning Vet').closest('li') as HTMLElement;
    expect(within(other).getByText('C')).toBeInTheDocument();
  });

  it('says so rather than guessing when a player has no position on record', async () => {
    // arrange
    watchlistMock.mockResolvedValue(
      payload({ players: [{ ...breakout, position: null }], position_coverage: { known: 243, unknown: 1 } })
    );

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.getByText('pos ?')).toBeInTheDocument();
    expect(
      screen.getByTitle(/roster table has no position for him, so a position filter cannot include him/i)
    ).toBeInTheDocument();
  });

  it('hides the games count and the breakdown for a one-night window', async () => {
    // arrange + act — "1 game tonight" is not news
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.queryByText(/1 game tonight/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('games-1630559')).not.toBeInTheDocument();
    expect(screen.getByTestId('ranking-note').textContent).toMatch(/where tonight projects/i);
  });
});

describe('WatchlistPage window picker', () => {
  it('offers the four windows a manager actually asks for', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    for (const label of ['Tonight', '3 days', 'Week', '2 weeks']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Tonight' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('refetches for the chosen window and shows the range the server resolved', async () => {
    // arrange
    renderPage();
    await screen.findByText('Breakout Wing');
    watchlistMock.mockResolvedValue(weekPayload());
    const user = userEvent.setup();

    // act
    await user.click(screen.getByRole('button', { name: 'Week' }));

    // assert — the range comes from the payload, never from the page's own maths
    expect(lastRequestWindow()).toEqual([7, null]);
    expect(await screen.findByText(/Feb 4 – Feb 10/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('leads the row with the games count, which is the streaming argument', async () => {
    // arrange
    watchlistMock.mockResolvedValue(weekPayload());

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const row = screen.getByText('Breakout Wing').closest('li') as HTMLElement;
    expect(within(row).getByText('4 games this week')).toBeInTheDocument();
    expect(within(row).getByText('2.40')).toBeInTheDocument();
  });

  it('says the ranking adds the games up rather than averaging them', async () => {
    // arrange
    watchlistMock.mockResolvedValue(weekPayload());

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert — visible on the page, not hidden in a tooltip
    const note = screen.getByTestId('ranking-note');
    expect(note.textContent).toMatch(/added up/i);
    expect(note.textContent).toMatch(/more games can outrank a better player with fewer/i);
  });

  it('breaks the window down game by game, including the ones that add nothing', async () => {
    // arrange
    watchlistMock.mockResolvedValue(weekPayload());

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const breakdown = screen.getByTestId('games-1630559');
    expect(within(breakdown).getByText('Feb 4')).toBeInTheDocument();
    expect(within(breakdown).getByText('Feb 9')).toBeInTheDocument();
    expect(within(breakdown).getByText('DEN')).toBeInTheDocument();
    // the flat night shows a 0 a reader can see rather than infer
    expect(within(breakdown).getByText('0.00')).toBeInTheDocument();
    expect(within(breakdown).getAllByRole('row')).toHaveLength(5);
  });

  it('drops the single opponent from the summary when there are several', async () => {
    // arrange
    watchlistMock.mockResolvedValue(weekPayload());

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert — "vs LAL" would be three quarters wrong over a four-game week
    const summary = screen.getByText('Breakout Wing').closest('summary') as HTMLElement;
    expect(summary.textContent).not.toMatch(/ vs LAL/);
  });

  it('explains the window total in the row evidence', async () => {
    // arrange
    watchlistMock.mockResolvedValue(weekPayload());

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const evidence = screen.getByTestId('evidence-1630559');
    expect(
      within(evidence).getByText(/4 games projected, adding up to a 2\.40 total at 0\.60 a game/)
    ).toBeInTheDocument();
    expect(within(evidence).getByText(/projected per game against a 22\.0 average/)).toBeInTheDocument();
  });

  it('explains the game-count badge in the legend once a window is chosen', async () => {
    // arrange
    watchlistMock.mockResolvedValue(weekPayload());

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    expect(screen.getByText(/adds up his games rather than averaging them/i)).toBeInTheDocument();
  });
});

describe('WatchlistPage position filter', () => {
  it('offers roster slots and exact positions, from the server vocabulary', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert
    const filter = screen.getByTestId('position-filter');
    for (const label of ['All positions', 'Guards', 'Forwards', 'Centers', 'PG', 'SG', 'SF', 'PF']) {
      expect(within(filter).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(filter).getByRole('button', { name: 'All positions' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('never offers a filter the server did not publish', async () => {
    // arrange — a server that only knows about roster slots
    watchlistMock.mockResolvedValue(payload({ position_options: ['G', 'F', 'C'] }));

    // act
    renderPage();
    await screen.findByText('Breakout Wing');

    // assert — a chip that cannot be honoured would only produce a 400
    const filter = screen.getByTestId('position-filter');
    expect(within(filter).getByRole('button', { name: 'Guards' })).toBeInTheDocument();
    expect(within(filter).queryByRole('button', { name: 'PG' })).not.toBeInTheDocument();
  });

  it('refetches for the chosen position and says the filter is on', async () => {
    // arrange
    renderPage();
    await screen.findByText('Breakout Wing');
    watchlistMock.mockResolvedValue(
      weekPayload({ position: 'G', position_coverage: { known: 1700, unknown: 12 } })
    );
    const user = userEvent.setup();

    // act
    await user.click(screen.getByRole('button', { name: 'Guards' }));

    // assert
    expect(lastRequestWindow()).toEqual([1, 'G']);
    expect(await screen.findByTestId('position-note')).toHaveTextContent(/guards only/i);
    expect(screen.getByTestId('position-note')).toHaveTextContent(
      /12 projected players have no position on record/i
    );
  });

  it('gives an empty position filter its own empty state', async () => {
    // arrange — the model has plenty to say, just not about centres
    renderPage();
    await screen.findByText('Breakout Wing');
    watchlistMock.mockResolvedValue(
      weekPayload({ position: 'C', players: [], position_coverage: { known: 1700, unknown: 3 } })
    );
    const user = userEvent.setup();

    // act
    await user.click(screen.getByRole('button', { name: 'Centers' }));

    // assert
    expect(await screen.findByText(/No centers clear the bar in this window/i)).toBeInTheDocument();
    expect(screen.getByText(/Try a longer window, a wider slot/i)).toBeInTheDocument();
    expect(
      screen.getByText(/3 projected players could not be considered at all/i)
    ).toBeInTheDocument();
    // and it is NOT the "nobody at all" state
    expect(
      screen.queryByText('Nobody is projected above their own usual in this window')
    ).not.toBeInTheDocument();
  });

  it('clears the filter from its own empty state', async () => {
    // arrange — get into the empty-at-this-position state by choosing it
    renderPage();
    await screen.findByText('Breakout Wing');
    const user = userEvent.setup();
    watchlistMock.mockResolvedValue(payload({ position: 'C', players: [] }));
    await user.click(screen.getByRole('button', { name: 'Centers' }));
    await screen.findByText(/No centers clear the bar/i);
    watchlistMock.mockResolvedValue(payload());

    // act
    await user.click(screen.getByRole('button', { name: 'every position' }));

    // assert — the all-positions list is already cached, so it comes straight back
    expect(await screen.findByText('Breakout Wing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All positions' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('explains that combo players answer every one of their positions', async () => {
    // arrange + act
    renderPage();
    await screen.findByRole('heading', { name: /What the badges mean/i });

    // assert
    expect(screen.getByText(/shows up under both Guards and PG/i)).toBeInTheDocument();
  });
});
