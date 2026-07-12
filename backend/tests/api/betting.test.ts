import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';
import { bearerFor } from '../helpers/authToken.js';

// mock the anthropic boundary: tests never hit the real api. buildBettingContext
// is also mocked because it queries teams/players — those joins are exercised
// implicitly by the prompt content and aren't the contract under test here.
vi.mock('../../src/services/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ai.js')>();
  return {
    ...actual,
    callClaude: vi.fn(),
    buildBettingContext: vi.fn().mockResolvedValue('CONTEXT'),
  };
});

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const { callClaude } = await import('../../src/services/ai.js');
const queryMock = vi.mocked(query);
const claudeMock = vi.mocked(callClaude);

beforeEach(() => {
  queryMock.mockReset();
  claudeMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// a scheduled ESPN event with the June-2026 odds shape (per-side close prices).
const espnEvent = {
  id: '401859966',
  date: '2026-06-11T00:30Z',
  status: { type: { name: 'STATUS_SCHEDULED', detail: 'Wed at 8:30 PM EDT', shortDetail: '6/10 - 8:30 PM EDT' } },
  competitions: [
    {
      competitors: [
        { homeAway: 'home', team: { displayName: 'New York Knicks', abbreviation: 'NY' } },
        { homeAway: 'away', team: { displayName: 'San Antonio Spurs', abbreviation: 'SA' } },
      ],
      odds: [
        {
          provider: { name: 'Draft Kings' },
          details: 'NY -2.5',
          overUnder: 216.5,
          spread: -2.5,
          moneyline: { home: { close: { odds: '-130' } }, away: { close: { odds: '+105' } } },
          pointSpread: {
            home: { close: { line: '-2.5', odds: '-105' } },
            away: { close: { line: '+2.5', odds: '-115' } },
          },
          total: {
            over: { close: { line: 'o216.5', odds: '-112' } },
            under: { close: { line: 'u216.5', odds: '-108' } },
          },
        },
      ],
    },
  ],
};

// NOTE: the odds service keeps a module-level 10-minute cache that only
// stores non-empty snapshots. test order in this file is deliberate:
// 1. ESPN failure cases (nothing cached)
// 2. the empty-window case (empty result is not cached)
// 3. the success case — which CACHES the snapshot
// 4. everything after relies on that cached snapshot instead of stubbing fetch
describe('GET /api/betting/odds', () => {
  it('returns 502 when ESPN responds with a non-OK status', async () => {
    // arrange
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response));

    // act
    const res = await request(app).get('/api/betting/odds');

    // assert
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('ESPN API unavailable');
  });

  it('returns 504 when the ESPN request aborts', async () => {
    // arrange
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    // act
    const res = await request(app).get('/api/betting/odds');

    // assert
    expect(res.status).toBe(504);
    expect(res.body.error).toBe('ESPN timed out');
  });

  it('reports no_games on /picks when the window has no scheduled games', async () => {
    // arrange — empty events parse to an empty snapshot, which is NOT cached
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [] }),
    } as Response));

    // act
    const res = await request(app)
      .get('/api/betting/picks')
      .set('Authorization', bearerFor(5));

    // assert — short-circuits before preferences/cache/AI: no db, no claude
    expect(res.status).toBe(200);
    expect(res.body.no_games).toBe(true);
    expect(res.body.picks).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(claudeMock).not.toHaveBeenCalled();
  });

  it('parses scheduled games with per-side prices and implied probabilities', async () => {
    // arrange
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [espnEvent] }),
    } as Response));

    // act
    const res = await request(app).get('/api/betting/odds');

    // assert
    expect(res.status).toBe(200);
    expect(res.body.games).toHaveLength(1);
    const game = res.body.games[0];
    expect(game.nba_game_id).toBe('401859966');
    expect(game.markets.spread.home_line).toBe(-2.5);
    expect(game.markets.spread.home_price).toBe(-105);
    expect(game.markets.total.line).toBe(216.5);
    expect(game.markets.moneyline.home).toBe(-130);
    expect(game.markets.moneyline.home_implied).toBeCloseTo(0.5652, 3);
  });
});

describe('GET /api/betting/picks', () => {
  it('rejects requests without a token', async () => {
    // act
    const res = await request(app).get('/api/betting/picks');

    // assert
    expect(res.status).toBe(401);
  });

  it('serves cached picks with kelly stakes computed from current bankroll', async () => {
    // arrange — odds come from the snapshot cached by the success test above.
    // db call order: getUserPreferences, then the betting_cache lookup.
    const cachedPicks = {
      picks: [
        {
          game_id: '401859966', category: 'best_value', market: 'spread', selection: 'home',
          matchup: 'San Antonio Spurs @ New York Knicks', game_date: '2026-06-10',
          tipoff: '6/10 - 8:30 PM EDT', selection_label: 'New York Knicks -2.5',
          line: -2.5, american_odds: -105, implied_prob: 0.5122,
          estimated_win_prob: 0.58, edge: 0.0678, rationale: 'rest advantage', confidence: 'medium',
        },
      ],
      parlay: null,
      summary: 'One strong play tonight.',
    };
    queryMock
      .mockResolvedValueOnce(pgResult([{ ai_preferences: { betting: { bankroll: 1000 } } }]))
      .mockResolvedValueOnce(pgResult([{ picks: cachedPicks, created_at: '2026-06-09T12:00:00Z' }]));

    // act
    const res = await request(app)
      .get('/api/betting/picks')
      .set('Authorization', bearerFor(5));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(claudeMock).not.toHaveBeenCalled();
    const pick = res.body.picks[0];
    expect(pick.kelly).not.toBeNull();
    expect(pick.kelly.suggested_stake).toBeGreaterThan(0);
  });

  it('returns kelly: null on cached picks when no bankroll is set', async () => {
    // arrange
    const cachedPicks = {
      picks: [{
        game_id: '401859966', category: 'safe', market: 'moneyline', selection: 'home',
        matchup: 'San Antonio Spurs @ New York Knicks', game_date: '2026-06-10',
        tipoff: '6/10 - 8:30 PM EDT', selection_label: 'New York Knicks ML (-130)',
        line: null, american_odds: -130, implied_prob: 0.5652,
        estimated_win_prob: 0.62, edge: 0.0548, rationale: 'better team', confidence: 'high',
      }],
      parlay: null,
      summary: '',
    };
    queryMock
      .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]))
      .mockResolvedValueOnce(pgResult([{ picks: cachedPicks, created_at: '2026-06-09T12:00:00Z' }]));

    // act
    const res = await request(app)
      .get('/api/betting/picks')
      .set('Authorization', bearerFor(5));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.picks[0].kelly).toBeNull();
  });

  it('generates fresh picks, re-attaches snapshot odds, and caches the result', async () => {
    // arrange — refresh=true skips the cache read; db: prefs, then cache upsert
    queryMock
      .mockResolvedValueOnce(pgResult([{ ai_preferences: { betting: { bankroll: 500 } } }]))
      .mockResolvedValueOnce(pgResult([]));
    claudeMock.mockResolvedValue(JSON.stringify({
      picks: [
        {
          game_id: '401859966', category: 'best_value', market: 'spread', selection: 'home',
          estimated_win_prob: 0.58, rationale: 'home edge', confidence: 'medium',
        },
        {
          // hallucinated game — must be dropped by enrichment
          game_id: '999999', category: 'safe', market: 'moneyline', selection: 'away',
          estimated_win_prob: 0.6, rationale: 'ghost game', confidence: 'high',
        },
      ],
      parlay: { legs: [{ game_id: '401859966', market: 'spread', selection: 'home' }], rationale: 'one leg only' },
      summary: 'Take the home side.',
    }));

    // act
    const res = await request(app)
      .get('/api/betting/picks')
      .query({ refresh: 'true' })
      .set('Authorization', bearerFor(5));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.picks).toHaveLength(1);
    const pick = res.body.picks[0];
    // numbers come from the snapshot, not the model
    expect(pick.american_odds).toBe(-105);
    expect(pick.line).toBe(-2.5);
    expect(pick.implied_prob).toBeCloseTo(0.5122, 3);
    expect(pick.edge).toBeCloseTo(0.58 - 0.5122, 3);
    expect(pick.selection_label).toBe('New York Knicks -2.5');
    expect(pick.kelly.suggested_stake).toBeGreaterThan(0);
    // a 1-leg parlay is rejected
    expect(res.body.parlay).toBeNull();
    // result was cached (without kelly fields)
    const upsert = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('INSERT INTO betting_cache')
    );
    expect(upsert).toBeDefined();
    const storedJson = JSON.parse((upsert![1] as string[])[2]);
    expect(storedJson.picks[0].kelly).toBeUndefined();
  });

  it('surfaces an empty result without caching when every pick fails validation', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]));
    claudeMock.mockResolvedValue(JSON.stringify({
      picks: [{ game_id: 'nope', category: 'safe', market: 'moneyline', selection: 'home', estimated_win_prob: 0.6, rationale: '', confidence: 'low' }],
      parlay: null,
      summary: 'nothing real',
    }));

    // act
    const res = await request(app)
      .get('/api/betting/picks')
      .query({ refresh: 'true' })
      .set('Authorization', bearerFor(5));

    // assert
    expect(res.status).toBe(200);
    expect(res.body._empty).toBe(true);
    const upsert = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('INSERT INTO betting_cache')
    );
    expect(upsert).toBeUndefined();
  });
});

describe('GET /api/betting/bets', () => {
  it('settles pending bets whose games went final, then returns the ledger', async () => {
    // arrange — one pending home -2.5 bet; home won by 10 → 'won'.
    queryMock
      // settlement join
      .mockResolvedValueOnce(pgResult([
        { id: 42, market: 'spread', selection: 'home', line: -2.5, home_score: 110, away_score: 100 },
      ]))
      // the UPDATE for bet 42
      .mockResolvedValueOnce(pgResult([]))
      // the final ledger SELECT
      .mockResolvedValueOnce(pgResult([
        {
          id: 42, nba_game_id: '401859966', home_team: 'New York Knicks',
          away_team: 'San Antonio Spurs', game_date: '2026-06-10', market: 'spread',
          selection: 'home', line: -2.5, american_odds: -105, stake: 50,
          status: 'won', created_at: '2026-06-09T12:00:00Z', settled_at: '2026-06-11T04:00:00Z',
        },
      ]));

    // act
    const res = await request(app)
      .get('/api/betting/bets')
      .set('Authorization', bearerFor(9));

    // assert — the UPDATE carries the computed outcome bound to the jwt user
    const [updateSql, updateParams] = queryMock.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE bets SET status/);
    expect(updateParams).toEqual(['won', 42, 9]);

    expect(res.status).toBe(200);
    expect(res.body.bets).toHaveLength(1);
    expect(res.body.bets[0].profit).toBeCloseTo(47.62, 2);
    expect(res.body.summary.wins).toBe(1);
    expect(res.body.summary.roi).toBeCloseTo(0.9524, 3);
  });

  it('binds every query to the jwt user id', async () => {
    // arrange
    queryMock
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([]));

    // act
    await request(app).get('/api/betting/bets').set('Authorization', bearerFor(77));

    // assert
    for (const [, params] of queryMock.mock.calls) {
      expect(params).toContain(77);
    }
  });
});

describe('POST /api/betting/bets', () => {
  const validBet = {
    nba_game_id: '888777',
    market: 'spread',
    selection: 'home',
    line: -4.5,
    american_odds: -110,
    stake: 25,
  };

  it('creates a bet, resolving game details from the db when not in the snapshot', async () => {
    // arrange — game id is not in the odds snapshot, so the route falls back
    // to the games table, then inserts.
    queryMock
      .mockResolvedValueOnce(pgResult([
        { home_team: 'Boston Celtics', away_team: 'Miami Heat', game_date: '2026-06-12' },
      ]))
      .mockResolvedValueOnce(pgResult([
        { id: 1, ...validBet, home_team: 'Boston Celtics', away_team: 'Miami Heat', game_date: '2026-06-12', status: 'pending', created_at: '2026-06-09T12:00:00Z', settled_at: null },
      ]));

    // act
    const res = await request(app)
      .post('/api/betting/bets')
      .set('Authorization', bearerFor(9))
      .send(validBet);

    // assert
    expect(res.status).toBe(201);
    expect(res.body.home_team).toBe('Boston Celtics');
    const insertCall = queryMock.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO bets'));
    expect(insertCall![1]![0]).toBe(9); // user_id from jwt
  });

  it.each([
    [{ ...validBet, market: 'props' }, 'Invalid market or selection'],
    [{ ...validBet, market: 'total', selection: 'home' }, 'Invalid market or selection'],
    [{ ...validBet, market: 'moneyline', line: -4.5 }, 'Moneyline bets have no line'],
    [{ ...validBet, line: undefined }, 'line is required for spread and total bets'],
    [{ ...validBet, line: 99 }, 'Spread line out of range'],
    [{ ...validBet, market: 'total', selection: 'over', line: 500 }, 'Total line out of range'],
    [{ ...validBet, american_odds: -50 }, 'american_odds must be an integer like -110 or +150'],
    [{ ...validBet, stake: 0 }, 'stake must be between 0 and 100000'],
  ])('rejects invalid payload %#', async (payload, message) => {
    // act
    const res = await request(app)
      .post('/api/betting/bets')
      .set('Authorization', bearerFor(9))
      .send(payload);

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
  });

  it('returns 400 for a game neither ESPN nor the db knows', async () => {
    // arrange — db lookup comes back empty
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/betting/bets')
      .set('Authorization', bearerFor(9))
      .send(validBet);

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown game');
  });
});

describe('DELETE /api/betting/bets/:id', () => {
  it('deletes an owned bet', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([{ id: 5 }]));

    // act
    const res = await request(app)
      .delete('/api/betting/bets/5')
      .set('Authorization', bearerFor(9));

    // assert
    expect(res.status).toBe(204);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([5, 9]);
  });

  it("404s when the bet doesn't exist or belongs to someone else", async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .delete('/api/betting/bets/5')
      .set('Authorization', bearerFor(9));

    // assert
    expect(res.status).toBe(404);
  });
});
