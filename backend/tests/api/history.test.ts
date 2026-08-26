import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const queryMock = vi.mocked(query);

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
    queryMock.mockResolvedValueOnce(
      pgResult([{ season: '2025-26' }, { season: '1996-97' }, { season: '1985-86' }])
    );

    const res = await request(app).get('/api/history/seasons');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seasons: ['2025-26', '1996-97', '1985-86'] });
  });

  it('returns an empty list before any backfill has run', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/history/seasons');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seasons: [] });
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/api/history/seasons');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch seasons');
  });
});

describe('GET /api/history/players', () => {
  it('returns the season, total, and player rows', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 441 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    const res = await request(app).get('/api/history/players').query({ season: '1996-97' });

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
    expect(typeof res.body.players[0].points_per_game).toBe('number');
  });

  it('binds the season as a query parameter rather than interpolating it', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    await request(app).get('/api/history/players').query({ season: '1996-97' });

    const [countSql, countParams] = queryMock.mock.calls[0];
    expect(countParams).toEqual(['1996-97']);
    expect(countSql).not.toContain('1996-97');
  });

  it('returns 400 when season is missing', async () => {
    const res = await request(app).get('/api/history/players');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid season/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 when season is malformed', async () => {
    const res = await request(app).get('/api/history/players').query({ season: '96/97' });

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('applies a case-insensitive name filter when search is provided', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 1 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '1996-97', search: 'jordan' });

    expect(res.status).toBe(200);
    expect(res.body.players).toHaveLength(1);
    expect(res.body.players[0].player_name).toBe('Michael Jordan');
    const [, countParams] = queryMock.mock.calls[0];
    expect(countParams).toContain('%jordan%');
  });

  it('caps limit at 1000 and passes it as a bound parameter', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 20000 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '1996-97', limit: '99999' });

    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['1996-97', 1000, 0]);
  });

  it('lets a single request cover the largest season', async () => {
    const LARGEST_SEASON_SIZE = 605; // 2021-22, inflated by two-way contracts
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: LARGEST_SEASON_SIZE }]))
      .mockResolvedValueOnce(pgResult([]));

    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '2021-22', limit: String(LARGEST_SEASON_SIZE) });

    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['2021-22', LARGEST_SEASON_SIZE, 0]);
  });

  it('honours limit and offset for paging', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 441 }]))
      .mockResolvedValueOnce(pgResult([jordan96]));

    const res = await request(app)
      .get('/api/history/players')
      .query({ season: '1996-97', limit: '25', offset: '50' });

    expect(res.status).toBe(200);
    const [, pageParams] = queryMock.mock.calls[1];
    expect(pageParams).toEqual(['1996-97', 25, 50]);
  });

  it('reports total 0 for a season with no rows', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ total: 0 }]))
      .mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/history/players').query({ season: '1979-80' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ season: '1979-80', total: 0, players: [] });
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/history/players').query({ season: '1996-97' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch season players');
  });
});

describe('GET /api/history/players/:nbaPlayerId/seasons', () => {
  it("returns a player's career oldest season first", async () => {
    queryMock.mockResolvedValueOnce(
      pgResult([
        { ...jordan96, season: '1995-96', points_per_game: 30.4 },
        jordan96,
      ])
    );

    const res = await request(app).get('/api/history/players/893/seasons');

    expect(res.status).toBe(200);
    expect(res.body.nba_player_id).toBe('893');
    expect(res.body.player_name).toBe('Michael Jordan');
    expect(res.body.seasons.map((s: { season: string }) => s.season)).toEqual([
      '1995-96',
      '1996-97',
    ]);
  });

  it('binds the player id as a query parameter', async () => {
    queryMock.mockResolvedValueOnce(pgResult([jordan96]));

    await request(app).get('/api/history/players/893/seasons');

    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['893']);
    expect(sql).toContain('$1');
  });

  it('returns 404 when the player has no historical seasons', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/history/players/999999/seasons');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no historical seasons/i);
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/api/history/players/893/seasons');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch player history');
  });
});

describe('GET /api/history/teams', () => {
  it("returns one season's teams", async () => {
    queryMock.mockResolvedValueOnce(pgResult([sonics96]));

    const res = await request(app).get('/api/history/teams').query({ season: '1996-97' });

    expect(res.status).toBe(200);
    expect(res.body.season).toBe('1996-97');
    expect(res.body.teams).toHaveLength(1);
    expect(res.body.teams[0]).toMatchObject({
      nba_team_id: '1610612760',
      team_name: 'Seattle SuperSonics',
      wins: 57,
      points_per_game: 101.4,
    });
    expect(res.body.teams[0].abbreviation).toBeNull();
    expect(res.body.teams[0].net_rating).toBeNull();
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['1996-97']);
  });

  it('returns 400 when season is missing or malformed', async () => {
    const missing = await request(app).get('/api/history/teams');
    const malformed = await request(app).get('/api/history/teams').query({ season: 'last-year' });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/api/history/teams').query({ season: '1996-97' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch season teams');
  });
});
