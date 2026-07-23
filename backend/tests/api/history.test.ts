import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const queryMock = vi.mocked(query);

// stat rows are shaped like the route's float8-cast select list
const jordan96 = {
  nba_player_id: '893',
  player_name: 'Michael Jordan',
  season: '1996-97',
  team: 'CHI',
  games_played: 82,
  minutes_per_game: 37.9,
  points_per_game: 29.6,
  rebounds_per_game: 5.9,
  assists_per_game: 4.3,
  steals_per_game: 1.7,
  blocks_per_game: 0.5,
  turnovers_per_game: 2.0,
  field_goal_percentage: 48.6,
  three_point_percentage: 37.4,
  free_throw_percentage: 83.3,
  three_pointers_made: 1.4,
};

const sonics96 = {
  nba_team_id: '1610612760',
  team_name: 'Seattle SuperSonics',
  abbreviation: null,
  season: '1996-97',
  games_played: 82,
  wins: 57,
  losses: 25,
  minutes_per_game: 48.3,
  points_per_game: 101.4,
  rebounds_per_game: 42.1,
  assists_per_game: 22.7,
  steals_per_game: 9.2,
  blocks_per_game: 5.1,
  turnovers_per_game: 14.6,
  field_goal_percentage: 46.4,
  three_point_percentage: 37.5,
  free_throw_percentage: 74.9,
  defensive_rating: null,
  offensive_rating: null,
  net_rating: null,
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /api/history/seasons', () => {
  it('returns the seasons present, newest first', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([{ season: '2025-26' }, { season: '1996-97' }, { season: '1985-86' }])
    );

    // act
    const res = await request(app).get('/api/history/seasons');

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seasons: ['2025-26', '1996-97', '1985-86'] });
  });

  it('returns an empty list before any backfill has run', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/history/seasons');

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seasons: [] });
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app).get('/api/history/seasons');

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch seasons');
  });
});

describe('GET /api/history/players', () => {
  it('returns the season, total, and player rows', async () => {
    // arrange — the route counts first, then reads the page
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 441 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    // act
    const res = await request(app).get('/api/history/players').query({ season: '1996-97' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.season).toBe('1996-97');
    expect(res.body.total).toBe(441);
    expect(res.body.players).toHaveLength(1);
    expect(res.body.players[0]).toMatchObject({
      nba_player_id: '893',
      player_name: 'Michael Jordan',
      season: '1996-97',
      team: 'CHI',
      games_played: 82,
      points_per_game: 29.6,
    });
    // stats arrive as json numbers, not pg's NUMERIC strings
    expect(typeof res.body.players[0].points_per_game).toBe('number');
  });

  it('binds the season as a query parameter rather than interpolating it', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    // act
    await request(app).get('/api/history/players').query({ season: '1996-97' });

    // assert
    const [countSql, countParams] = queryMock.mock.calls[0];
    expect(countParams).toEqual(['1996-97']);
    expect(countSql).not.toContain('1996-97');
  });

  it('returns 400 when season is missing', async () => {
    // act
    const res = await request(app).get('/api/history/players');

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid season/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 when season is malformed', async () => {
    // act
    const res = await request(app).get('/api/history/players').query({ season: '96/97' });

    // assert
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('applies a case-insensitive name filter when search is provided', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    // act
    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '1996-97', search: 'jordan' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.players).toHaveLength(1);
    expect(res.body.players[0].player_name).toBe('Michael Jordan');
    const [, countParams] = queryMock.mock.calls[0];
    expect(countParams).toContain('%jordan%');
  });

  // 1000, not the shared 500 default: modern seasons run past 500 players once
  // two-way contracts are counted, and the UI loads a season in one request.
  it('caps limit at 1000 and passes it as a bound parameter', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 20000 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    // act
    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '1996-97', limit: '99999' });

    // assert
    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['1996-97', 1000, 0]);
  });

  // regression: the ceiling used to be 500, which silently truncated any season
  // with more players than that — 2021-22 has 605, so its lowest-scoring 105
  // players could neither be listed nor found by search.
  it('lets a single request cover the largest season', async () => {
    // arrange
    const LARGEST_SEASON_SIZE = 605; // 2021-22, inflated by two-way contracts
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: LARGEST_SEASON_SIZE }]))
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '2021-22', limit: String(LARGEST_SEASON_SIZE) });

    // assert
    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['2021-22', LARGEST_SEASON_SIZE, 0]);
  });

  it('honours limit and offset for paging', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 441 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    // act
    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '1996-97', limit: '25', offset: '50' });

    // assert
    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['1996-97', 25, 50]);
  });

  it('reports total 0 for a season with no rows', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 0 }]))
      .mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/history/players').query({ season: '1979-80' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ season: '1979-80', total: 0, players: [] });
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValue(new Error('db down'));

    // act
    const res = await request(app).get('/api/history/players').query({ season: '1996-97' });

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch season players');
  });
});

describe('GET /api/history/players/:nbaPlayerId/seasons', () => {
  it("returns a player's career oldest season first", async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([
        { ...jordan96, season: '1995-96', points_per_game: 30.4 },
        jordan96,
      ])
    );

    // act
    const res = await request(app).get('/api/history/players/893/seasons');

    // assert
    expect(res.status).toBe(200);
    expect(res.body.nba_player_id).toBe('893');
    expect(res.body.player_name).toBe('Michael Jordan');
    expect(res.body.seasons.map((s: { season: string }) => s.season)).toEqual([
      '1995-96',
      '1996-97',
    ]);
  });

  it('binds the player id as a query parameter', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([jordan96]));

    // act
    await request(app).get('/api/history/players/893/seasons');

    // assert
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['893']);
    expect(sql).toContain('$1');
  });

  it('returns 404 when the player has no historical seasons', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/history/players/999999/seasons');

    // assert
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no historical seasons/i);
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app).get('/api/history/players/893/seasons');

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch player history');
  });
});

describe('GET /api/history/teams', () => {
  it("returns one season's teams", async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([sonics96]));

    // act
    const res = await request(app).get('/api/history/teams').query({ season: '1996-97' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body.season).toBe('1996-97');
    expect(res.body.teams).toHaveLength(1);
    expect(res.body.teams[0]).toMatchObject({
      nba_team_id: '1610612760',
      team_name: 'Seattle SuperSonics',
      wins: 57,
      points_per_game: 101.4,
    });
    // defunct franchises keep their own identity — no mapping onto the modern
    // team that inherited the id (1610612760 is now OKC)
    expect(res.body.teams[0].abbreviation).toBeNull();
    // pre-1996-97 advanced measures are genuinely absent, so ratings are nullable
    expect(res.body.teams[0].net_rating).toBeNull();
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['1996-97']);
  });

  it('returns 400 when season is missing or malformed', async () => {
    // act
    const missing = await request(app).get('/api/history/teams');
    const malformed = await request(app).get('/api/history/teams').query({ season: 'last-year' });

    // assert
    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app).get('/api/history/teams').query({ season: '1996-97' });

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch season teams');
  });
});
