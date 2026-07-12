import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { pgResult } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/games', () => {
  it('returns games within the recent-plus-upcoming window by default', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 1, home_team: 'Spurs', away_team: 'Knicks', game_date: '2026-06-03' }])
    );

    // act
    const res = await request(app).get('/api/games');

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // the default query must bound by date so weeks-old games don't surface
    // as "recent". bounds are passed as ET date-string params, no LIMIT.
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/game_date >= \$1 AND game_date <= \$2/);
    expect(sql).not.toMatch(/LIMIT/i);
    const [start, end] = params as string[];
    // both bounds look like YYYY-MM-DD and start precedes end.
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(start < end).toBe(true);
  });

  it('queries a single exact date when ?date= is provided', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app).get('/api/games').query({ date: '2026-06-03' });

    // assert
    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE game_date = \$1/);
    expect(params).toEqual(['2026-06-03']);
  });

  it('returns 500 when the database query fails', async () => {
    // arrange
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app).get('/api/games');

    // assert
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch games');
  });
});

describe('GET /api/games/live', () => {
  // a minimal ESPN scoreboard payload: one finished game and one upcoming
  // scheduled game, matching the fields the route reads.
  const espnPayload = {
    events: [
      {
        id: '401',
        date: '2026-06-04T00:30Z',
        status: { type: { name: 'STATUS_FINAL', detail: 'Final', shortDetail: 'Final' }, period: 4, displayClock: '0:00' },
        competitions: [
          {
            venue: { fullName: 'Frost Bank Center' },
            competitors: [
              { homeAway: 'home', score: '110', team: { displayName: 'San Antonio Spurs' } },
              { homeAway: 'away', score: '104', team: { displayName: 'New York Knicks' } },
            ],
          },
        ],
      },
      {
        id: '402',
        date: '2026-06-09T00:30Z',
        status: { type: { name: 'STATUS_SCHEDULED', detail: 'Mon, June 8th at 8:30 PM EDT', shortDetail: '8:30 PM EDT' }, period: 0, displayClock: '0:00' },
        competitions: [
          {
            venue: { fullName: 'Madison Square Garden' },
            competitors: [
              { homeAway: 'home', score: '', team: { displayName: 'New York Knicks' } },
              { homeAway: 'away', score: '', team: { displayName: 'San Antonio Spurs' } },
            ],
          },
        ],
      },
      {
        id: '403',
        date: '2026-06-07T00:30Z',
        status: { type: { name: 'STATUS_IN_PROGRESS', detail: 'Q3 4:21', shortDetail: 'Q3 4:21' }, period: 3, displayClock: '4:21' },
        competitions: [
          {
            venue: { fullName: 'Frost Bank Center' },
            competitors: [
              { homeAway: 'home', score: '67', team: { displayName: 'San Antonio Spurs' } },
              { homeAway: 'away', score: '72', team: { displayName: 'New York Knicks' } },
            ],
          },
        ],
      },
    ],
  };

  it('returns 502 when ESPN responds with a non-OK status', async () => {
    // arrange
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as Response));

    // act
    const res = await request(app).get('/api/games/live');

    // assert
    expect(res.status).toBe(502);
  });

  it('returns 504 when the ESPN request times out (aborts)', async () => {
    // arrange
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    // act
    const res = await request(app).get('/api/games/live');

    // assert
    expect(res.status).toBe(504);
  });

  it('returns an empty array when ESPN reports no games in the window', async () => {
    // arrange — empty events is the deep-off-season / no-games-today case.
    // it must not be cached, so it never poisons a later successful fetch.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [] }),
    } as Response));

    // act
    const res = await request(app).get('/api/games/live');

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // this test sets the module-level live cache, so it must run last among the
  // /live tests — any /live request after it (within the 3-min TTL) would be
  // served the cached payload instead of hitting the fetch mock.
  it('fetches a date range and parses final, scheduled, and in-progress games', async () => {
    // arrange
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => espnPayload,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    // the writeback loop runs one query per event; resolve them all.
    queryMock.mockResolvedValue(pgResult([]));

    // act
    const res = await request(app).get('/api/games/live');

    // assert
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    // the request must use a date RANGE, not the default today-only scoreboard.
    const requestedUrl = fetchMock.mock.calls[0][0] as string;
    expect(requestedUrl).toMatch(/dates=\d{8}-\d{8}/);

    // one writeback query per event.
    expect(queryMock).toHaveBeenCalledTimes(3);

    const final = res.body.find((g: { id: string }) => g.id === '401');
    const scheduled = res.body.find((g: { id: string }) => g.id === '402');
    const live = res.body.find((g: { id: string }) => g.id === '403');

    // final game keeps its scores.
    expect(final.status).toBe('Final');
    expect(final.home_score).toBe(110);

    // scheduled game has null scores and shows the compact tip-off time.
    expect(scheduled.home_score).toBeNull();
    expect(scheduled.status).toBe('8:30 PM EDT');

    // in-progress game surfaces the period and game clock for the live badge.
    expect(live.status).toBe('In Progress');
    expect(live.period).toBe(3);
    expect(live.game_clock).toBe('4:21');
    expect(live.home_score).toBe(67);
  });
});
