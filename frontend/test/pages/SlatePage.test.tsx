import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SlatePage } from '../../src/pages/SlatePage';
import type { SlatePlayer, SlateResponse } from '../../src/types';

// mock the api boundary — these tests exercise the page's branches, not http.
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return { ...actual, getSlate: vi.fn() };
});

const { getSlate } = await import('../../src/api/client');
const slateMock = vi.mocked(getSlate);

function slatePlayer(overrides: Partial<SlatePlayer> = {}): SlatePlayer {
  return {
    nba_player_id: '201939',
    name: 'Stephen Curry',
    name_is_placeholder: false,
    team_abbr: 'GSW',
    prob_active: 0.99,
    proj_pts: 28.4,
    proj_min_p50: 33.1,
    projected: { reb: 4.6, ast: 6.1, stl: 1.2, blk: 0.3, tov: 2.8, fg3m: 4.4 },
    usual_min: 32.4,
    usual_pts: 26.9,
    min_vs_usual: 0.7,
    pts_vs_usual: 1.5,
    baseline_games: 15,
    impact: 6.2,
    spotlight: true,
    slate_spotlight: true,
    ...overrides,
  };
}

function payload(overrides: Partial<SlateResponse> = {}): SlateResponse {
  return {
    date: '2026-02-04',
    run: { model_version: 'v1-decomposed', predicted_at: '2026-02-04T11:00:00Z' },
    pool: {
      key: 'slate',
      label: "Tonight's slate",
      definition: "every player the run projects for this date, across all of the date's games",
      sample_size: 2,
    },
    baseline: {
      window_games: 15,
      min_games: 5,
      notable_min_delta: 4,
      label: 'his own recent form',
      definition: 'per-game averages over his last 15 games played before this date',
    },
    games: [
      {
        nba_game_id: '0022500555',
        game_status: 'Scheduled',
        home_team_id: '1610612747',
        home_team_abbr: 'LAL',
        away_team_id: '1610612744',
        away_team_abbr: 'GSW',
        top_impact: 6.2,
        players: [
          slatePlayer(),
          slatePlayer({
            nba_player_id: '2544',
            name: 'LeBron James',
            team_abbr: 'LAL',
            prob_active: 0.42,
            proj_pts: 18.6,
            proj_min_p50: 30.5,
            projected: { reb: 7.2, ast: 8.4, stl: 0.9, blk: 0.5, tov: 3.4, fg3m: 1.6 },
            usual_min: 24.3,
            usual_pts: 24.1,
            min_vs_usual: 6.2,
            pts_vs_usual: -5.5,
            baseline_games: 15,
            impact: 2.1,
            spotlight: true,
            slate_spotlight: false,
          }),
        ],
      },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projections']}>
      <SlatePage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  slateMock.mockResolvedValue(payload());
});

describe('SlatePage', () => {
  it('renders each game as a card with its projected players', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByRole('heading', { name: /GSW.*@.*LAL/ })).toBeInTheDocument();
    expect(screen.getByText('Stephen Curry')).toBeInTheDocument();
    expect(screen.getByText('LeBron James')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('shows the projected line and availability percentage for each player', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — points, minutes and the availability badge
    expect(screen.getByText('28.4')).toBeInTheDocument();
    expect(screen.getByText(/33\.1 min/)).toBeInTheDocument();
    expect(screen.getByText('99%')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('names the model run behind the projections', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByText(/model v1-decomposed/)).toBeInTheDocument();
  });

  it('shows the per-category projections so the line is more than points', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert
    expect(screen.getByText(/4\.6 REB · 6\.1 AST · 1\.2 STL · 0\.3 BLK · 4\.4 3PM · 2\.8 TOV/))
      .toBeInTheDocument();
  });

  it('shows each player total projected impact, signed', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — 0 is an average night on the slate, so the sign carries meaning
    expect(screen.getByText('+6.2')).toBeInTheDocument();
    expect(screen.getByText('+2.1')).toBeInTheDocument();
  });

  it('marks the slate standouts and explains every badge in the legend', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — one of the two is a slate-wide standout, the other is not
    expect(screen.getByLabelText('Top projected impact on the slate')).toBeInTheDocument();
    // the legend must explain all three symbols inline, where they are visible
    // without hovering — the tooltip-only version confused a real user
    const legend = screen.getByTestId('slate-legend');
    expect(legend).toHaveTextContent(/impact/i);
    expect(legend).toHaveTextContent(/0 = average night/i);
    expect(legend).toHaveTextContent(/chance he plays/i);
    expect(legend).toHaveTextContent(/slate standout/i);
  });

  it('renders a placeholder when availability was not modelled', async () => {
    // arrange
    slateMock.mockResolvedValue(
      payload({
        games: [
          {
            ...payload().games[0],
            players: [slatePlayer({ prob_active: null })],
          },
        ],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText('Stephen Curry')).toBeInTheDocument();
    expect(screen.getByTitle('Availability not modelled')).toHaveTextContent('-');
  });

  it('renders a placeholder when the run projected no impact for a player', async () => {
    // arrange
    slateMock.mockResolvedValue(
      payload({
        games: [
          {
            ...payload().games[0],
            top_impact: null,
            players: [slatePlayer({ impact: null, spotlight: false, slate_spotlight: false })],
          },
        ],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText('Stephen Curry')).toBeInTheDocument();
    expect(
      screen.getByTitle('No impact score for this player')
    ).toHaveTextContent('-');
  });

  it('labels a player with no roster row by id instead of showing a blank name', async () => {
    // arrange — the server never sends an empty name; it sends this
    slateMock.mockResolvedValue(
      payload({
        games: [
          {
            ...payload().games[0],
            players: [
              slatePlayer({
                nba_player_id: '1642850',
                name: 'NBA #1642850 (new roster)',
                name_is_placeholder: true,
                team_abbr: null,
              }),
            ],
          },
        ],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText('NBA #1642850 (new roster)')).toBeInTheDocument();
    expect(
      screen.getByTitle(/Not on a roster yet, so this is his NBA id/i)
    ).toBeInTheDocument();
  });

  it('says what the impact number means without explaining how it is computed', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — what it means, not the pool or the z-scoring behind it
    expect(screen.getByText(/ordered by projected impact/i)).toBeInTheDocument();
    expect(screen.getByText(/0 is an average night/i)).toBeInTheDocument();
    expect(screen.queryByText(/z-score/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/every player the run projects for this date/i)).toBeNull();
  });

  it('explains that no model run has completed yet, while still listing the games', async () => {
    // arrange
    slateMock.mockResolvedValue(
      payload({
        run: null,
        games: [{ ...payload().games[0], players: [] }],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/No prediction run yet/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /GSW.*@.*LAL/ })).toBeInTheDocument();
    expect(screen.getByText(/No projected players for this game yet/i)).toBeInTheDocument();
  });

  it('shows an empty state for a day with no games', async () => {
    // arrange
    slateMock.mockResolvedValue(payload({ games: [] }));

    // act
    renderPage();

    // assert
    expect(await screen.findByText('No games scheduled')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /the watchlist/i })).toHaveAttribute(
      'href',
      '/watchlist'
    );
  });

  it('refetches for another date when the picker changes', async () => {
    // arrange
    renderPage();
    await screen.findByText('Stephen Curry');
    slateMock.mockResolvedValue(payload({ date: '2026-02-06', games: [] }));

    // act — a date input is set wholesale, not typed character by character
    fireEvent.change(screen.getByLabelText('Game date'), { target: { value: '2026-02-06' } });

    // assert
    expect(await screen.findByText('No games scheduled')).toBeInTheDocument();
    expect(slateMock).toHaveBeenLastCalledWith('2026-02-06');
  });

  it('shows an error state with a retry button when the request fails', async () => {
    // arrange
    slateMock.mockRejectedValue(new Error('slate down'));

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/Failed to load the slate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });

  it('chips a player whose minutes depart from his own usual, and leaves the rest alone', async () => {
    // arrange + act — LeBron is +6.2 over his recent average, Curry +0.7
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert
    expect(screen.getByText(/\+6\.2 min vs usual/)).toBeInTheDocument();
    expect(screen.queryByText(/\+0\.7 min vs usual/)).not.toBeInTheDocument();
  });

  it('keeps the chip meaning in its tooltip rather than restating the threshold', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — the chip says what changed; the footer no longer explains the bar
    expect(
      screen.getByTitle('Usually 24.3 min, tonight 30.5. Points -5.5 vs usual.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/last 15 games played before this date/i)).toBeNull();
  });

  it('chips a minutes drop too, in a different tone', async () => {
    // arrange
    slateMock.mockResolvedValue(
      payload({
        games: [
          {
            ...payload().games[0],
            players: [slatePlayer({ usual_min: 34, min_vs_usual: -5.1 })],
          },
        ],
      })
    );

    // act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — a fall is as much a lineup decision as a jump
    expect(screen.getByText(/-5\.1 min vs usual/)).toBeInTheDocument();
  });

  it('shows no chip for a player with too little history to have a usual', async () => {
    // arrange — a rookie is not "unchanged", he is unknown
    slateMock.mockResolvedValue(
      payload({
        games: [
          {
            ...payload().games[0],
            players: [
              slatePlayer({
                usual_min: null,
                usual_pts: null,
                min_vs_usual: null,
                pts_vs_usual: null,
                baseline_games: 0,
              }),
            ],
          },
        ],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText('Stephen Curry')).toBeInTheDocument();
    expect(screen.queryByText(/min vs usual/)).not.toBeInTheDocument();
  });

  it('shows no chips at all when the server sent no baseline descriptor', async () => {
    // arrange — a Lambda caught mid-deploy: the client fills in an empty one
    slateMock.mockResolvedValue(
      payload({
        baseline: {
          window_games: 0,
          min_games: 0,
          notable_min_delta: 0,
          label: '',
          definition: '',
        },
      })
    );

    // act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert
    expect(screen.queryByText(/min vs usual/)).not.toBeInTheDocument();
  });

  it('orders the players as the server ranked them', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — the server ranks by total impact; the page must not resort
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('Stephen Curry')).toBeInTheDocument();
    expect(within(rows[1]).getByText('LeBron James')).toBeInTheDocument();
  });
});
