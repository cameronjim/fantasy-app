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
    // as "recent", and must drop phantom past games (past date + null scores).
    // bounds are ET date-string params, no LIMIT.
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/game_date >= \$1 AND game_date <= \$2/);
    expect(sql).toMatch(/NOT \(game_date < \$3 AND home_score IS NULL AND away_score IS NULL\)/);
    expect(sql).not.toMatch(/LIMIT/i);
    const [start, end, today] = params as string[];
    // all three bounds look like YYYY-MM-DD; start < today < end.
    for (const p of [start, end, today]) {
      expect(p).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(start < today).toBe(true);
    expect(today < end).toBe(true);
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
  // an ESPN-style UTC timestamp for the ET calendar date `offsetDays` from
  // now. dates are relative to today so the phantom-past-game filter (which
  // is anchored to the real "today") behaves identically whatever date the
  // suite runs on. 16:00Z lands at late-morning ET year-round, so the ET
  // calendar day always matches the intended offset.
  const espnDate = (offsetDays: number): string => {
    const iso = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return `${iso}T16:00Z`;
  };

  // a representative ESPN payload spanning the four cases the route handles:
  // a finished game (yesterday), an in-progress game (today), an upcoming
  // scheduled game (tomorrow), and a "phantom" past game — a never-played
  // "if necessary" playoff game still on the schedule with null scores.
  const espnPayload = {
    events: [
      {
        id: '401',
        date: espnDate(-1),
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
        date: espnDate(1),
        status: { type: { name: 'STATUS_SCHEDULED', detail: 'Tomorrow at 8:30 PM EDT', shortDetail: '8:30 PM EDT' }, period: 0, displayClock: '0:00' },
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
        date: espnDate(0),
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
      {
        // phantom: a past-dated game that was never played (null scores).
        id: '499',
        date: espnDate(-3),
        status: { type: { name: 'STATUS_SCHEDULED', detail: 'If necessary', shortDetail: 'If necessary' }, period: 0, displayClock: '0:00' },
        competitions: [
          {
            venue: { fullName: 'Rocket Mortgage FieldHouse' },
            competitors: [
              { homeAway: 'home', score: '', team: { displayName: 'Cleveland Cavaliers' } },
              { homeAway: 'away', score: '', team: { displayName: 'New York Knicks' } },
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
  it('fetches a date range, parses each game type, and drops phantom past games', async () => {
    // arrange
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => espnPayload,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    // the writeback loop runs one query per non-phantom game; resolve them all.
    queryMock.mockResolvedValue(pgResult([]));

    // act
    const res = await request(app).get('/api/games/live');

    // assert
    expect(res.status).toBe(200);
    // four events in, but the phantom (id 499) is filtered out, so three out.
    expect(res.body).toHaveLength(3);
    expect(res.body.find((g: { id: string }) => g.id === '499')).toBeUndefined();

    // the request must use a date RANGE, not the default today-only scoreboard.
    const requestedUrl = fetchMock.mock.calls[0][0] as string;
    expect(requestedUrl).toMatch(/dates=\d{8}-\d{8}/);

    // one writeback query per non-phantom game; the phantom is never written.
    expect(queryMock).toHaveBeenCalledTimes(3);

    const final = res.body.find((g: { id: string }) => g.id === '401');
    const scheduled = res.body.find((g: { id: string }) => g.id === '402');
    const live = res.body.find((g: { id: string }) => g.id === '403');

    // final game keeps its scores.
    expect(final.status).toBe('Final');
    expect(final.home_score).toBe(110);

    // upcoming game has null scores and shows the compact tip-off time.
    expect(scheduled.home_score).toBeNull();
    expect(scheduled.status).toBe('8:30 PM EDT');

    // in-progress game surfaces the period and game clock for the live badge.
    expect(live.status).toBe('In Progress');
    expect(live.period).toBe(3);
    expect(live.game_clock).toBe('4:21');
    expect(live.home_score).toBe(67);
  });
});
