import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlayerPage } from '../../src/pages/PlayerPage';
import type { PlayerAnalytics } from '../../src/types';

// mock the api boundary — these tests exercise the page's branches, not http.
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    getPlayerAnalytics: vi.fn(),
  };
});

const { getPlayerAnalytics } = await import('../../src/api/client');
const analyticsMock = vi.mocked(getPlayerAnalytics);

function fullPayload(overrides: Partial<PlayerAnalytics> = {}): PlayerAnalytics {
  return {
    player: {
      id: 1,
      nba_id: '2544',
      name: 'Test Allstar',
      team: 'LAL',
      position: 'PG',
      headshot_url: null,
    },
    as_of: { logs: '2026-02-04T12:00:00Z', distributions: '2026-02-04T13:00:00Z' },
    pool: {
      key: 'rotation',
      label: 'Rotation players',
      definition: 'GP >= 15 and MPG >= 12 this season',
      sample_size: 312,
    },
    percentiles: [
      { stat: 'pts', value: 28.5, percentile: 94 },
      { stat: 'tov', value: 3.1, percentile: 22 },
      { stat: 'fg_impact', value: 1.8, percentile: 81 },
      { stat: 'ft_impact', value: 0.6, percentile: 64 },
    ],
    distributions: [
      {
        stat: 'pts',
        mean: 14.2,
        stddev: 5.6,
        player_value: 28.5,
        buckets: [
          { lo: 0, hi: 10, count: 90 },
          { lo: 10, hi: 20, count: 150 },
          { lo: 20, hi: 30, count: 60 },
          { lo: 30, hi: 40, count: 12 },
        ],
      },
      {
        stat: 'reb',
        mean: 5.1,
        stddev: 2.4,
        player_value: 7.1,
        buckets: [
          { lo: 0, hi: 5, count: 140 },
          { lo: 5, hi: 10, count: 150 },
        ],
      },
    ],
    trends: {
      games: [
        {
          game_date: '2026-02-01',
          opponent_team_abbr: 'BOS',
          is_home: true,
          minutes: 35,
          pts: 31,
          reb: 8,
          ast: 9,
          stl: 2,
          blk: 1,
          tov: 3,
          fgm: 11,
          fga: 21,
          fg3m: 3,
          fg3a: 7,
          ftm: 6,
          fta: 7,
        },
        {
          game_date: '2026-02-03',
          opponent_team_abbr: 'GSW',
          is_home: false,
          minutes: 33,
          pts: 24,
          reb: 6,
          ast: 7,
          stl: 1,
          blk: 0,
          tov: 4,
          fgm: 9,
          fga: 19,
          fg3m: 2,
          fg3a: 6,
          ftm: 4,
          fta: 4,
        },
      ],
      rolling: [
        { game_date: '2026-02-01', min_r5: 34.2, pts_r5: 27.5, pts_r10: 26.9, reb_r5: 7.0, ast_r5: 8.1 },
        { game_date: '2026-02-03', min_r5: 34.0, pts_r5: 28.1, pts_r10: 27.2, reb_r5: 7.2, ast_r5: 8.3 },
      ],
      last10_vs_season: [
        { stat: 'pts', last10: 31.2, season: 28.5, delta: 2.7, z: 1.6 },
        { stat: 'blk', last10: 0.9, season: 0.6, delta: 0.3, z: null },
      ],
    },
    prediction: null,
    ...overrides,
  };
}

function renderPage(playerId = '1') {
  return render(
    <MemoryRouter initialEntries={[`/player/${playerId}`]}>
      <Routes>
        <Route path="/player/:id" element={<PlayerPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  analyticsMock.mockResolvedValue(fullPayload());
});

describe('PlayerPage', () => {
  it('renders the header, percentiles, distribution, trends and recent games from a full payload', async () => {
    // arrange + act
    renderPage();

    // assert — header
    expect(await screen.findByRole('heading', { name: 'Test Allstar' })).toBeInTheDocument();
    expect(screen.getByText(/LAL.*PG/)).toBeInTheDocument();
    expect(analyticsMock).toHaveBeenCalledWith(1);

    // percentile panel, including the impact stats' friendly labels
    expect(screen.getByRole('heading', { name: /Category Percentiles/i })).toBeInTheDocument();
    expect(screen.getByLabelText('PTS percentile')).toHaveValue(94);
    expect(screen.getByText('FG Impact')).toBeInTheDocument();
    expect(screen.getByText('FT Impact')).toBeInTheDocument();

    // distribution + trends + recent games sections all present
    expect(screen.getByRole('heading', { name: /Distribution/i })).toBeInTheDocument();
    expect(screen.getByTestId('distribution-chart')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Trends/i })).toBeInTheDocument();
    expect(screen.getByTestId('points-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('minutes-trend-chart')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Recent Games/i })).toBeInTheDocument();
    expect(screen.getByText('BOS')).toBeInTheDocument();
    expect(screen.getByText('GSW')).toBeInTheDocument();
  });

  it('shows the pool label, definition and sample size next to the percentile bars', async () => {
    // arrange + act
    renderPage();

    // assert
    const poolLine = await screen.findByText(/^vs rotation players/i);
    expect(poolLine).toHaveTextContent('GP >= 15 and MPG >= 12 this season');
    expect(poolLine).toHaveTextContent('n=312');
  });

  it('marks a last-10 swing beyond one standard deviation and flags a null z as a small sample', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByText('+2.7')).toBeInTheDocument();
    expect(screen.getByText(/small sample/i)).toBeInTheDocument();
  });

  it('switches the histogram when another distribution stat is picked', async () => {
    // arrange
    renderPage();
    await screen.findByRole('heading', { name: /Distribution/i });
    const user = userEvent.setup();

    // act
    await user.click(screen.getByRole('tab', { name: 'REB' }));

    // assert
    expect(screen.getByRole('tab', { name: 'REB' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('distribution-chart')).toBeInTheDocument();
  });

  it('degrades to percentiles only when the player has no game logs', async () => {
    // arrange
    analyticsMock.mockResolvedValue(
      fullPayload({
        as_of: { logs: null, distributions: '2026-02-04T13:00:00Z' },
        trends: { games: [], rolling: [], last10_vs_season: [] },
      })
    );

    // act
    renderPage();

    // assert — percentiles still render, trend surfaces do not
    expect(await screen.findByRole('heading', { name: /Category Percentiles/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Distribution/i })).toBeInTheDocument();
    expect(screen.getByText('No game logs yet')).toBeInTheDocument();
    expect(screen.queryByTestId('points-trend-chart')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Recent Games/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Game logs as of no game logs yet/i)).toBeInTheDocument();
  });

  it('omits the prediction card while the api returns a null prediction', async () => {
    // arrange + act
    renderPage();
    await screen.findByRole('heading', { name: 'Test Allstar' });

    // assert
    expect(screen.queryByRole('heading', { name: /Projection/i })).not.toBeInTheDocument();
  });

  it('renders the prediction card once the api returns one', async () => {
    // arrange
    analyticsMock.mockResolvedValue(
      fullPayload({
        prediction: {
          summary: 'Usage should hold with Doncic out.',
          projected: { pts: 30.1, reb: 7.4 },
          confidence: 'medium',
          as_of: '2026-02-04T14:00:00Z',
        },
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByRole('heading', { name: /Projection/i })).toBeInTheDocument();
    expect(screen.getByText(/Usage should hold/i)).toBeInTheDocument();
    expect(screen.getByText('30.1')).toBeInTheDocument();
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
  });

  it('shows an error state with a retry button when the analytics call fails', async () => {
    // arrange
    analyticsMock.mockRejectedValue(new Error('analytics down'));

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/Failed to load player analytics/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });

  it('rejects a non-numeric player id without calling the api', async () => {
    // arrange + act
    renderPage('not-a-player');

    // assert
    expect(await screen.findByText(/Unknown player/i)).toBeInTheDocument();
    expect(analyticsMock).not.toHaveBeenCalled();
  });
});
