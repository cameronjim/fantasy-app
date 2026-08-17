import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const { clearAnalyticsCache, ANALYTICS_STATS, POOL_DEFINITION } = await import(
  '../../src/services/analytics.js'
);
const queryMock = vi.mocked(query);

// the analytics routes issue their queries in a fixed order:
//   1. the player row
//   2. pool season averages, pool game-log totals, team abbreviations
//   3. the player's own game logs
// steps 2 is skipped once the pool snapshot is cached.

const lebronRow = {
  id: 5,
  nba_id: '2544',
  name: 'LeBron James',
  team: 'LAL',
  position: 'SF',
  headshot_url: 'https://cdn.nba.com/headshots/2544.png',
  pts: 25.4,
  reb: 7.2,
  ast: 8.1,
  stl: 1.1,
  blk: 0.6,
  fg3m: 2.1,
  tov: 3.4,
  minutes: 35.2,
};

const poolRows = [
  { ...lebronRow },
  {
    id: 6, nba_id: '201939', name: 'Stephen Curry', pts: 29.1, reb: 5.0, ast: 6.3,
    stl: 1.3, blk: 0.2, fg3m: 5.1, tov: 3.1, minutes: 34.0,
  },
  {
    id: 7, nba_id: '203507', name: 'Giannis Antetokounmpo', pts: 30.2, reb: 11.4, ast: 5.7,
    stl: 1.0, blk: 1.2, fg3m: 0.8, tov: 3.9, minutes: 33.1,
  },
];

const poolTotalsRows = [
  { nba_player_id: '2544', fgm: 200, fga: 400, ftm: 80, fta: 100, games: 20 },
  { nba_player_id: '201939', fgm: 190, fga: 420, ftm: 90, fta: 100, games: 20 },
  { nba_player_id: '203507', fgm: 230, fga: 400, ftm: 110, fta: 180, games: 20 },
];

const teamRows = [
  { team_id: '1610612744', team_abbr: 'GSW' },
  { team_id: '1610612749', team_abbr: 'MIL' },
];

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    game_date: '2026-01-02',
    opponent_team_id: '1610612744',
    is_home: true,
    minutes: 35,
    pts: 25, reb: 7, ast: 8, stl: 1, blk: 1, tov: 3,
    fgm: 10, fga: 20, fg3m: 2, fg3a: 5, ftm: 3, fta: 4,
    ...overrides,
  };
}

// 20 games so the z-score threshold (15) is cleared
const logRows = Array.from({ length: 20 }, (_, i) =>
  logRow({
    game_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    pts: 20 + i,
    is_home: i % 2 === 0,
  })
);

function mockPlayerAnalyticsQueries(logs: Array<Record<string, unknown>> = logRows): void {
  queryMock
    .mockResolvedValueOnce(pgResult([lebronRow]))
    .mockResolvedValueOnce(pgResult(poolRows))
    .mockResolvedValueOnce(pgResult(poolTotalsRows))
    .mockResolvedValueOnce(pgResult(teamRows))
    .mockResolvedValueOnce(pgResult(logs));
}

function mockPoolQueries(): void {
  queryMock
    .mockResolvedValueOnce(pgResult(poolRows))
    .mockResolvedValueOnce(pgResult(poolTotalsRows))
    .mockResolvedValueOnce(pgResult(teamRows));
}

beforeEach(() => {
  queryMock.mockReset();
  // the pool snapshot is cached for an hour; each test starts from cold
  clearAnalyticsCache();
});

describe('GET /api/players/:id/analytics', () => {
  it('returns the player, pool, percentiles, distributions and trends', async () => {
    // arrange
    mockPlayerAnalyticsQueries();

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    expect(res.status).toBe(200);
    expect(res.body.player).toEqual({
      id: 5,
      nba_id: '2544',
      name: 'LeBron James',
      team: 'LAL',
      position: 'SF',
      headshot_url: 'https://cdn.nba.com/headshots/2544.png',
      injury_status: null,
      injury_detail: null,
    });
    expect(res.body.pool).toEqual({
      key: 'rotation',
      label: 'Rotation players',
      definition: POOL_DEFINITION,
      sample_size: 3,
    });
    expect(res.body.prediction).toBeNull();
    expect(res.body.as_of.logs).toBe('2026-01-20T00:00:00.000Z');
    expect(typeof res.body.as_of.distributions).toBe('string');
  });

  it('covers every whitelisted stat in percentiles and distributions', async () => {
    // arrange
    mockPlayerAnalyticsQueries();

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    expect(res.body.percentiles.map((p: { stat: string }) => p.stat)).toEqual([
      ...ANALYTICS_STATS,
    ]);
    expect(res.body.distributions.map((d: { stat: string }) => d.stat)).toEqual([
      ...ANALYTICS_STATS,
    ]);
    const points = res.body.percentiles.find((p: { stat: string }) => p.stat === 'pts');
    expect(points.value).toBe(25.4);
    // lowest scorer of the three -> bottom of the pool
    expect(points.percentile).toBeLessThan(50);
  });

  it('ranks turnovers in reverse, so the lowest-turnover player scores highest', async () => {
    // arrange — LeBron's 3.4 is the middle of 3.1 / 3.4 / 3.9
    mockPlayerAnalyticsQueries();

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    const turnovers = res.body.percentiles.find((p: { stat: string }) => p.stat === 'tov');
    expect(turnovers.percentile).toBe(50);
  });

  it('marks each distribution with the player value and equal-width buckets', async () => {
    // arrange
    mockPlayerAnalyticsQueries();

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    const points = res.body.distributions.find((d: { stat: string }) => d.stat === 'pts');
    expect(points.player_value).toBe(25.4);
    expect(points.mean).toBeCloseTo(28.233, 3);
    expect(points.buckets).toHaveLength(20);
    const counted = points.buckets.reduce(
      (sum: number, b: { count: number }) => sum + b.count,
      0
    );
    expect(counted).toBe(3);
  });

  it('returns the last 20 games oldest first with the opponent abbreviation', async () => {
    // arrange — 24 logged games, only the last 20 are returned
    const many = Array.from({ length: 24 }, (_, i) =>
      logRow({ game_date: `2026-02-${String(i + 1).padStart(2, '0')}`, pts: i })
    );
    mockPlayerAnalyticsQueries(many);

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    expect(res.body.trends.games).toHaveLength(20);
    expect(res.body.trends.games[0].game_date).toBe('2026-02-05');
    expect(res.body.trends.games[19].game_date).toBe('2026-02-24');
    expect(res.body.trends.games[0].opponent_team_abbr).toBe('GSW');
    expect(res.body.trends.games[0].is_home).toBe(true);
  });

  it('aligns the rolling series with the returned games, using history before the window', async () => {
    // arrange — 24 games scoring 20..43, so the 20-game window starts at game 5
    const many = Array.from({ length: 24 }, (_, i) =>
      logRow({ game_date: `2026-02-${String(i + 1).padStart(2, '0')}`, pts: 20 + i })
    );
    mockPlayerAnalyticsQueries(many);

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    const { games, rolling } = res.body.trends;
    expect(rolling).toHaveLength(games.length);
    expect(rolling[0].game_date).toBe(games[0].game_date);
    // the first charted game already has four earlier games behind it, so the
    // 5-game line starts populated rather than null
    expect(rolling[0].pts_r5).toBe(22);
    expect(rolling[0].pts_r10).toBeNull();
    expect(rolling[5].pts_r10).toBe(24.5);
  });

  it('compares the last ten games to the season with a volatility-scaled z', async () => {
    // arrange
    mockPlayerAnalyticsQueries();

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    const points = res.body.trends.last10_vs_season.find(
      (c: { stat: string }) => c.stat === 'pts'
    );
    expect(points).toMatchObject({ last10: 34.5, season: 29.5, delta: 5 });
    expect(points.z).toBeCloseTo(0.87, 2);
  });

  it('nulls the z-score for a player with fewer than 15 logged games', async () => {
    // arrange
    const few = Array.from({ length: 8 }, (_, i) =>
      logRow({ game_date: `2026-03-0${i + 1}`, pts: 10 + i })
    );
    mockPlayerAnalyticsQueries(few);

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    const points = res.body.trends.last10_vs_season.find(
      (c: { stat: string }) => c.stat === 'pts'
    );
    expect(points.z).toBeNull();
    // the 10-game rolling line has no data to stand on yet
    expect(res.body.trends.rolling.every((r: { pts_r10: number | null }) => r.pts_r10 === null))
      .toBe(true);
  });

  it('still returns percentiles and distributions for a player with no game logs', async () => {
    // arrange
    mockPlayerAnalyticsQueries([]);

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    expect(res.status).toBe(200);
    expect(res.body.as_of.logs).toBeNull();
    expect(res.body.trends).toEqual({ games: [], rolling: [], last10_vs_season: [] });
    expect(res.body.percentiles).toHaveLength(ANALYTICS_STATS.length);
    expect(res.body.distributions).toHaveLength(ANALYTICS_STATS.length);
    // no attempts logged means no measurable shooting impact, not a penalty
    const fgImpact = res.body.percentiles.find(
      (p: { stat: string }) => p.stat === 'fg_impact'
    );
    expect(fgImpact.value).toBe(0);
  });

  it('binds the player id as a query parameter rather than interpolating it', async () => {
    // arrange
    mockPlayerAnalyticsQueries();

    // act
    await request(app).get('/api/players/5/analytics');

    // assert
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual([5]);
    expect(sql).toContain('$1');
  });

  it('reuses the cached pool snapshot on the next request', async () => {
    // arrange
    mockPlayerAnalyticsQueries();
    await request(app).get('/api/players/5/analytics');
    const afterFirst = queryMock.mock.calls.length;
    queryMock
      .mockResolvedValueOnce(pgResult([lebronRow]))
      .mockResolvedValueOnce(pgResult(logRows));

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert — only the player row and their logs, no pool aggregates
    expect(res.status).toBe(200);
    expect(afterFirst).toBe(5);
    expect(queryMock.mock.calls.length - afterFirst).toBe(2);
    expect(res.body.pool.sample_size).toBe(3);
  });

  it('returns 404 when no player has that id', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/players/999999/analytics');

    // assert
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Player not found');
  });

  it('returns 400 for a non-numeric player id', async () => {
    // act
    const res = await request(app).get('/api/players/lebron/analytics');

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/numeric player id/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValue(new Error('db down'));

    // act
    const res = await request(app).get('/api/players/5/analytics');

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch player analytics');
  });
});

describe('GET /api/analytics/distributions', () => {
  it('returns the pool shape and every player value for one stat', async () => {
    // arrange
    mockPoolQueries();

    // act
    const res = await request(app).get('/api/analytics/distributions').query({ stat: 'pts' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.stat).toBe('pts');
    expect(res.body.pool).toEqual({
      key: 'rotation',
      label: 'Rotation players',
      definition: POOL_DEFINITION,
      sample_size: 3,
    });
    expect(res.body.mean).toBeCloseTo(28.233, 3);
    expect(res.body.buckets).toHaveLength(20);
    expect(res.body.players).toHaveLength(3);
    expect(res.body.players[0]).toEqual({
      id: 7,
      name: 'Giannis Antetokounmpo',
      value: 30.2,
      percentile: 83.3,
    });
  });

  it('accepts an explicit rotation pool', async () => {
    // arrange
    mockPoolQueries();

    // act
    const res = await request(app)
      .get('/api/analytics/distributions')
      .query({ stat: 'blk', pool: 'rotation' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.stat).toBe('blk');
  });

  it('orders turnovers best-first, so the fewest turnovers lead', async () => {
    // arrange
    mockPoolQueries();

    // act
    const res = await request(app).get('/api/analytics/distributions').query({ stat: 'tov' });

    // assert
    expect(res.body.players[0].name).toBe('Stephen Curry');
    expect(res.body.players[0].percentile).toBe(83.3);
    expect(res.body.players[2].name).toBe('Giannis Antetokounmpo');
  });

  it('returns the attempt-weighted shooting impact as a stat', async () => {
    // arrange
    mockPoolQueries();

    // act
    const res = await request(app)
      .get('/api/analytics/distributions')
      .query({ stat: 'fg_impact' });

    // assert — 230/400 against a pool rate of 620/1220 beats it on volume
    expect(res.status).toBe(200);
    expect(res.body.players[0].name).toBe('Giannis Antetokounmpo');
    expect(res.body.players[0].value).toBeGreaterThan(0);
  });

  it('returns 400 for a stat outside the whitelist', async () => {
    // act
    const res = await request(app)
      .get('/api/analytics/distributions')
      .query({ stat: 'points_per_game' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stat must be one of/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 when stat is missing', async () => {
    // act
    const res = await request(app).get('/api/analytics/distributions');

    // assert
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown pool', async () => {
    // act
    const res = await request(app)
      .get('/api/analytics/distributions')
      .query({ stat: 'pts', pool: 'starters' });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pool must be/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValue(new Error('db down'));

    // act
    const res = await request(app).get('/api/analytics/distributions').query({ stat: 'pts' });

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch stat distribution');
  });
});
