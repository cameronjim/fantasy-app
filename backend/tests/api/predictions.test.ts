import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const { REASON_WEIGHTS } = await import('../../src/services/watchlist.js');
const { IMPACT_POOL_KEY, IMPACT_POOL_LABEL, IMPACT_POOL_DEFINITION, POINTS_UNCOND_STAT } =
  await import('../../src/services/slate.js');
const queryMock = vi.mocked(query);

/** The pool descriptor every slate response echoes, for a pool of `size`. */
function poolOf(size: number): Record<string, unknown> {
  return {
    key: IMPACT_POOL_KEY,
    label: IMPACT_POOL_LABEL,
    definition: IMPACT_POOL_DEFINITION,
    sample_size: size,
  };
}

// the slate route issues its queries in a fixed order:
//   1. the day's schedule
//   2. the latest complete prediction run
//   3. team_id -> abbreviation
//   4. the run's per-player predictions (skipped when there is no run)
//
// the watchlist route:
//   1. player rows (names, teams, injury status, season averages)
//   2. the rolling game-log aggregates
//   3. the latest complete prediction run
//   4. prob_active for the date (skipped when there is no run)

/** pg's "relation does not exist" — what an unapplied migration looks like. */
function undefinedTable(relation: string): Error & { code: string } {
  const err = new Error(`relation "${relation}" does not exist`) as Error & { code: string };
  err.code = '42P01';
  return err;
}

const scheduleRows = [
  {
    nba_game_id: '0022500555',
    game_status: 'Scheduled',
    home_team_id: '1610612747',
    away_team_id: '1610612744',
  },
];

const teamRows = [
  { team_id: '1610612747', team_abbr: 'LAL' },
  { team_id: '1610612744', team_abbr: 'GSW' },
];

const runRow = {
  id: 42,
  model_version: 'v1-decomposed',
  predicted_at: new Date('2026-02-04T11:00:00.000Z'),
};

/**
 * One pivoted prediction row as `fetchPredictions` returns it: the box-score
 * columns are the run's UNCONDITIONAL expectations (`<stat>_uncond`), which is
 * what makes them comparable across a slate.
 */
function predictionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nba_game_id: '0022500555',
    nba_player_id: '2544',
    name: 'LeBron James',
    team_abbr: 'LAL',
    prob_active: 0.93,
    proj_min_p50: 34.2,
    pts: 24.6,
    reb: 7.4,
    ast: 8.1,
    stl: 1.1,
    blk: 0.6,
    tov: 3.2,
    fg3m: 2.0,
    fgm: 9.2,
    fga: 18.0,
    ftm: 4.1,
    fta: 5.6,
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /api/predictions/slate', () => {
  it('returns each scheduled game with its top projected players', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult(teamRows))
      .mockResolvedValueOnce(
        pgResult([
          predictionRow(),
          predictionRow({
            nba_player_id: '201939',
            name: 'Stephen Curry',
            team_abbr: 'GSW',
            prob_active: 0.99,
            pts: 28.4,
            proj_min_p50: 33.1,
          }),
        ])
      );

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-02-04');
    expect(res.body.run).toEqual({
      model_version: 'v1-decomposed',
      predicted_at: '2026-02-04T11:00:00.000Z',
    });
    expect(res.body.pool).toEqual(poolOf(2));
    expect(res.body.games).toHaveLength(1);
    expect(res.body.games[0]).toMatchObject({
      nba_game_id: '0022500555',
      game_status: 'Scheduled',
      home_team_id: '1610612747',
      home_team_abbr: 'LAL',
      away_team_id: '1610612744',
      away_team_abbr: 'GSW',
    });
    // the two rows are identical except for points, so points is the only
    // category that separates them and the better scorer leads on impact.
    expect(res.body.games[0].players[0]).toEqual({
      nba_player_id: '201939',
      name: 'Stephen Curry',
      name_is_placeholder: false,
      team_abbr: 'GSW',
      prob_active: 0.99,
      proj_pts: 28.4,
      proj_min_p50: 33.1,
      projected: { reb: 7.4, ast: 8.1, stl: 1.1, blk: 0.6, tov: 3.2, fg3m: 2 },
      impact: 1,
      spotlight: true,
      slate_spotlight: true,
    });
    expect(res.body.games[0].top_impact).toBe(1);
  });

  it('reads the unconditional stat names, not `conditional = false` on the bare ones', async () => {
    // arrange — the contradictory predicate this endpoint used to carry matched
    // zero rows, which showed up as "- pts" for every player rather than as an
    // error. See the STAT VOCABULARY block in services/slate.ts.
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult(teamRows))
      .mockResolvedValueOnce(pgResult([predictionRow()]));

    // act
    await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    const [sql, params] = queryMock.mock.calls[3];
    expect(params).toContain(POINTS_UNCOND_STAT);
    expect(params).not.toContain('pts');
    expect(sql).not.toMatch(/conditional\s*=\s*false/);
  });

  it('caps each game at eight players', async () => {
    // arrange
    const many = Array.from({ length: 15 }, (_, i) =>
      predictionRow({ nba_player_id: String(i), name: `Player ${i}`, pts: i })
    );
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult(teamRows))
      .mockResolvedValueOnce(pgResult(many));

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.body.games[0].players).toHaveLength(8);
    expect(res.body.games[0].players[0].name).toBe('Player 14');
  });

  it('labels a player with no roster row instead of rendering a blank name', async () => {
    // arrange — an offseason addition the season-stats scrape has not written
    // yet: predictions exist, `players` has nothing, so the LEFT JOIN gives a
    // NULL name. As an empty string it also sorted FIRST alphabetically.
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult(teamRows))
      .mockResolvedValueOnce(
        pgResult([
          predictionRow({ nba_player_id: '1642850', name: null, team_abbr: null, pts: 4.1 }),
          predictionRow({ nba_player_id: '201939', name: 'Stephen Curry', pts: 28.4 }),
        ])
      );

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    const [first, second] = res.body.games[0].players;
    expect(first.name).toBe('Stephen Curry');
    expect(second.name).toBe('NBA #1642850 (new roster)');
    expect(second.name_is_placeholder).toBe(true);
    expect(first.name_is_placeholder).toBe(false);
  });

  it('spotlights the top impact players per game and across the slate', async () => {
    // arrange — five players in one game, separated only by points
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult(teamRows))
      .mockResolvedValueOnce(
        pgResult(
          [30, 24, 18, 12, 6].map((pts, i) =>
            predictionRow({ nba_player_id: `p${i}`, name: `Player ${i}`, pts })
          )
        )
      );

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert — three per game, and all five are inside the slate's top ten
    const players = res.body.games[0].players;
    expect(players.map((p: { spotlight: boolean }) => p.spotlight)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(players.every((p: { slate_spotlight: boolean }) => p.slate_spotlight)).toBe(true);
    // impact is a z-score sum, so an average night on this slate is 0
    expect(players[2].impact).toBe(0);
  });

  it('orders the game cards by the biggest projected impact on them', async () => {
    // arrange — the star is in the game with the LATER id, which is where the
    // old schedule-order listing would have buried him
    queryMock
      .mockResolvedValueOnce(
        pgResult([
          { ...scheduleRows[0], nba_game_id: '0022500111' },
          { ...scheduleRows[0], nba_game_id: '0022500999' },
        ])
      )
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult(teamRows))
      .mockResolvedValueOnce(
        pgResult([
          predictionRow({ nba_game_id: '0022500111', nba_player_id: 'a', pts: 9.5 }),
          predictionRow({ nba_game_id: '0022500999', nba_player_id: 'b', pts: 31.5 }),
        ])
      );

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.body.games.map((g: { nba_game_id: string }) => g.nba_game_id)).toEqual([
      '0022500999',
      '0022500111',
    ]);
    expect(res.body.games[0].top_impact).toBeGreaterThan(res.body.games[1].top_impact);
  });

  it('still lists the games when no run has finished yet', async () => {
    // arrange — schedule present, no complete run
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult(teamRows));

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.run).toBeNull();
    expect(res.body.games).toHaveLength(1);
    expect(res.body.games[0].players).toEqual([]);
    // the prediction query is never issued without a run to read
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('returns an empty slate for a day with no games', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([])).mockResolvedValueOnce(pgResult([runRow]));

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-07-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: '2026-07-04',
      run: { model_version: 'v1-decomposed', predicted_at: '2026-02-04T11:00:00.000Z' },
      pool: poolOf(0),
      games: [],
    });
  });

  it('degrades to an empty slate when the prediction tables do not exist yet', async () => {
    // arrange — deployed ahead of the migration
    queryMock.mockRejectedValue(undefinedTable('nba_schedule'));

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: '2026-02-04', run: null, pool: poolOf(0), games: [] });
  });

  it('keeps the games when only the prediction tables are missing', async () => {
    // arrange — 013 applied, 014 not
    queryMock
      .mockResolvedValueOnce(pgResult(scheduleRows))
      .mockRejectedValueOnce(undefinedTable('prediction_runs'))
      .mockResolvedValueOnce(pgResult(teamRows));

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.run).toBeNull();
    expect(res.body.games).toHaveLength(1);
  });

  it('defaults to today when no date is given', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([])).mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/predictions/slate');

    // assert
    expect(res.status).toBe(200);
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(queryMock.mock.calls[0][1]).toEqual([res.body.date]);
  });

  it('returns 400 for a malformed date without touching the database', async () => {
    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '04-02-2026' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database is actually down', async () => {
    // arrange — an outage must not be reported as a quiet day with no games
    queryMock.mockRejectedValue(new Error('db down'));

    // act
    const res = await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch slate');
  });

  it('binds the date as a query parameter rather than interpolating it', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([])).mockResolvedValueOnce(pgResult([]));

    // act
    await request(app).get('/api/predictions/slate').query({ date: '2026-02-04' });

    // assert
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['2026-02-04']);
    expect(sql).toContain('$1');
  });
});

const playerMetaRows = [
  {
    nba_id: '1630559',
    name: 'Breakout Wing',
    team: 'OKC',
    injury_status: null,
    minutes_per_game: 24.1,
    points_per_game: 11.2,
  },
  {
    nba_id: '203507',
    name: 'Franchise Player',
    team: 'OKC',
    injury_status: 'Out',
    minutes_per_game: 34.6,
    points_per_game: 29.8,
  },
  {
    nba_id: '2544',
    name: 'Steady Vet',
    team: 'LAL',
    injury_status: null,
    minutes_per_game: 30.0,
    points_per_game: 15.5,
  },
];

function aggregateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nba_player_id: '1630559',
    min_r5: 30.2,
    min_r15: 22.0,
    fga_r5: 12.4,
    fga_r15: 9.1,
    pts_r5: 18.6,
    pts_season: 11.2,
    pts_stddev: 4.0,
    last_game_date: '2026-02-03',
    prev_game_date: '2026-02-01',
    last_game_minutes: 33,
    ...overrides,
  };
}

describe('GET /api/watchlist', () => {
  it('ranks candidates with their reason codes and evidence', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult(playerMetaRows))
      .mockResolvedValueOnce(pgResult([aggregateRow()]))
      .mockResolvedValueOnce(pgResult([runRow]))
      .mockResolvedValueOnce(pgResult([{ nba_player_id: '1630559', prob_active: 0.88 }]));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-02-04');
    expect(res.body.players).toHaveLength(1);

    const candidate = res.body.players[0];
    expect(candidate.nba_player_id).toBe('1630559');
    expect(candidate.name).toBe('Breakout Wing');
    expect(candidate.team_abbr).toBe('OKC');
    expect(candidate.prob_active).toBe(0.88);
    expect(candidate.reasons).toEqual([
      'ROLE_INCREASE',
      'SHOT_VOLUME_SURGE',
      'HOT_STREAK',
      'TEAMMATE_ABSENCE',
    ]);
    expect(candidate.evidence).toMatchObject({
      min_r5: 30.2,
      min_r15: 22,
      min_delta: 8.2,
      fga_delta: 3.3,
      pts_delta: 7.4,
      teammate_out: 'Franchise Player',
      teammate_out_minutes: 34.6,
    });

    const weight =
      REASON_WEIGHTS.ROLE_INCREASE +
      REASON_WEIGHTS.SHOT_VOLUME_SURGE +
      REASON_WEIGHTS.HOT_STREAK +
      REASON_WEIGHTS.TEAMMATE_ABSENCE;
    expect(candidate.score).toBeCloseTo(weight * 0.88, 3);
  });

  it('scores on the rules alone when no prediction run exists', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult(playerMetaRows))
      .mockResolvedValueOnce(pgResult([aggregateRow()]))
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    const candidate = res.body.players[0];
    expect(candidate.prob_active).toBeNull();
    expect(candidate.score).toBeCloseTo(
      REASON_WEIGHTS.ROLE_INCREASE +
        REASON_WEIGHTS.SHOT_VOLUME_SURGE +
        REASON_WEIGHTS.HOT_STREAK +
        REASON_WEIGHTS.TEAMMATE_ABSENCE,
      3
    );
    // the prob_active query is never issued without a run to read
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('flags a player returning from a long absence', async () => {
    // arrange — nine days between the last two appearances, and he played
    queryMock
      .mockResolvedValueOnce(pgResult(playerMetaRows))
      .mockResolvedValueOnce(
        pgResult([
          aggregateRow({
            nba_player_id: '2544',
            min_r5: 24,
            min_r15: 24,
            fga_r5: 9,
            fga_r15: 9,
            pts_r5: 15,
            pts_season: 15,
            pts_stddev: 3,
            last_game_date: '2026-02-03',
            prev_game_date: '2026-01-25',
          }),
        ])
      )
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.body.players[0].reasons).toEqual(['RETURNING_FROM_ABSENCE']);
    expect(res.body.players[0].evidence).toEqual({
      gap_days: 9,
      last_game_date: '2026-02-03',
    });
  });

  it('excludes established scorers from the discovery list', async () => {
    // arrange — the 29.8 ppg star has every rule firing
    queryMock
      .mockResolvedValueOnce(pgResult(playerMetaRows))
      .mockResolvedValueOnce(pgResult([aggregateRow({ nba_player_id: '203507' })]))
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.players).toEqual([]);
  });

  it('does not count a player as their own absent teammate', async () => {
    // arrange — the only Out player on LAL would be the candidate himself
    const lakersOnly = [
      {
        nba_id: '2544',
        name: 'Steady Vet',
        team: 'LAL',
        injury_status: 'Out',
        minutes_per_game: 33,
        points_per_game: 15.5,
      },
    ];
    queryMock
      .mockResolvedValueOnce(pgResult(lakersOnly))
      .mockResolvedValueOnce(
        pgResult([
          aggregateRow({
            nba_player_id: '2544',
            fga_r5: 9,
            fga_r15: 9,
            pts_r5: 15,
            pts_season: 15,
            prev_game_date: '2026-02-01',
          }),
        ])
      )
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.body.players[0].reasons).toEqual(['ROLE_INCREASE']);
  });

  it('degrades to an empty list when the game-log tables do not exist yet', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult(playerMetaRows))
      .mockRejectedValueOnce(undefinedTable('player_game_logs'))
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: '2026-02-04', players: [] });
  });

  it('returns 400 for a malformed date without touching the database', async () => {
    // act
    const res = await request(app).get('/api/watchlist').query({ date: 'yesterday' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database is actually down', async () => {
    // arrange
    queryMock.mockRejectedValue(new Error('db down'));

    // act
    const res = await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch watchlist');
  });

  it('reads only games strictly before the requested date', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]));

    // act
    await request(app).get('/api/watchlist').query({ date: '2026-02-04' });

    // assert — the cutoff is what keeps this a forecast rather than hindsight
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toContain('g.game_date < $1');
    expect(params).toEqual(['2026-02-04']);
  });
});
