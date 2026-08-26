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
    queryMock.mockResolvedValueOnce(
      pgResult([{ id: 1, home_team: 'Spurs', away_team: 'Knicks', game_date: '2026-06-03' }])
    );

    const res = await request(app).get('/api/games');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/game_date >= \$1 AND game_date <= \$2/);
    expect(sql).toMatch(/NOT \(game_date < \$3 AND home_score IS NULL AND away_score IS NULL\)/);
    expect(sql).not.toMatch(/LIMIT/i);
    const [start, end, today] = params as string[];
    for (const p of [start, end, today]) {
      expect(p).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(start < today).toBe(true);
    expect(today < end).toBe(true);
  });

  it('queries a single exact date when ?date= is provided', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app).get('/api/games').query({ date: '2026-06-03' });

    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE game_date = \$1/);
    expect(params).toEqual(['2026-06-03']);
  });

  it('returns 500 when the database query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/api/games');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch games');
  });
});

describe('GET /api/games/live', () => {
  const espnDate = (offsetDays: number): string => {
    const iso = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return `${iso}T16:00Z`;
  };

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as Response));

    const res = await request(app).get('/api/games/live');

    expect(res.status).toBe(502);
  });

  it('returns 504 when the ESPN request times out (aborts)', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const res = await request(app).get('/api/games/live');

    expect(res.status).toBe(504);
  });

  it('returns an empty array when ESPN reports no games in the window', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [] }),
    } as Response));

    const res = await request(app).get('/api/games/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('fetches a date range, parses each game type, and drops phantom past games', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => espnPayload,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    queryMock.mockResolvedValue(pgResult([]));

    const res = await request(app).get('/api/games/live');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.find((g: { id: string }) => g.id === '499')).toBeUndefined();

    const requestedUrl = fetchMock.mock.calls[0][0] as string;
    expect(requestedUrl).toMatch(/dates=\d{8}-\d{8}/);

    expect(queryMock).toHaveBeenCalledTimes(3);

    const final = res.body.find((g: { id: string }) => g.id === '401');
    const scheduled = res.body.find((g: { id: string }) => g.id === '402');
    const live = res.body.find((g: { id: string }) => g.id === '403');

    expect(final.status).toBe('Final');
    expect(final.home_score).toBe(110);

    expect(scheduled.home_score).toBeNull();
    expect(scheduled.status).toBe('8:30 PM EDT');

    expect(live.status).toBe('In Progress');
    expect(live.period).toBe(3);
    expect(live.game_clock).toBe('4:21');
    expect(live.home_score).toBe(67);
  });
});
