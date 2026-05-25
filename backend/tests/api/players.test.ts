import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';

// players.test needs a non-empty score map (the route overlays fantasy_score
// onto the db rows). override the empty default from setup.ts.
vi.mock('../../src/services/fantasyScore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/fantasyScore.js')>();
  return {
    ...actual,
    getRankedPlayers: vi.fn().mockResolvedValue([]),
    getScoresById: vi.fn().mockResolvedValue(
      new Map([[1, { fantasy_score: 48.4, fantasy_rank: 12 }]])
    ),
  };
});

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /api/players', () => {
  it('returns 200 with an array enriched by fantasy score data', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([
        { id: 1, name: 'Test Player', team: 'LAL', position: 'PG', points_per_game: 25 },
      ])
    );

    // act
    const res = await request(app).get('/api/players');

    // assert
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({
      id: 1,
      name: 'Test Player',
      fantasy_score: 48.4,
      fantasy_rank: 12,
    });
  });

  it('filters by name when ?search= is provided', async () => {
    // arrange — the route is responsible for narrowing results by name. we
    // assert that behavior by checking the response surfaces only the
    // matching row we returned, and that the search term reached the
    // query as a parameter (not interpolated into the sql).
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 1, name: 'Curry', team: 'GSW', position: 'PG' }])
    );

    // act
    const res = await request(app).get('/api/players').query({ search: 'curry' });

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Curry');
    const [, params] = queryMock.mock.calls[0];
    expect(params).toContain('%curry%');
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app).get('/api/players');

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch players');
  });
});

describe('GET /api/players/:id', () => {
  it('returns 404 when the player does not exist', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/players/9999');

    // assert
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Player not found');
  });

  it('returns the player record when found', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 7, name: 'Test Center', team: 'BOS', position: 'C' }])
    );

    // act
    const res = await request(app).get('/api/players/7');

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, name: 'Test Center' });
  });
});
