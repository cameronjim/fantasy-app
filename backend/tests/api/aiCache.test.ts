import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { pgResult } from '../helpers/mockDb.js';
import { bearerFor } from '../helpers/authToken.js';

// benchmarks keep a module-level hourly cache that would make query-mock
// sequencing order-dependent — pin them so every test sees the same key.
vi.mock('../../src/services/benchmarks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/benchmarks.js')>();
  return {
    ...actual,
    getCurrentBenchmarks: vi.fn().mockResolvedValue({
      PTS: 15.0, REB: 5.0, AST: 3.5, STL: 1.0, BLK: 0.7,
      'FG%': 46.0, 'FT%': 78.0, '3PM': 1.5, TO: 1.8,
      sample_size: 150,
    }),
  };
});

const { app } = await import('../../src/app.js');
const { query } = await import('../../src/db.js');
const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

// query order for /team-analysis: buildTeamContext roster join, getRosterHash,
// getUserPreferences, then the cache lookups (benchmarks are mocked above).
const rosterRow = {
  name: 'Test Player', team: 'NY', position: 'PG',
  points_per_game: 20, rebounds_per_game: 5, assists_per_game: 7,
  steals_per_game: 1, blocks_per_game: 0.5, field_goal_percentage: 45,
  free_throw_percentage: 80, three_pointers_made: 2, turnovers_per_game: 2,
  injury_status: null,
};

function mockAnalysisPreamble(): void {
  queryMock
    .mockResolvedValueOnce(pgResult([rosterRow]))            // buildTeamContext
    .mockResolvedValueOnce(pgResult([{ player_id: 1 }]))     // getRosterHash
    .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }])); // preferences
}

const ANALYSIS = {
  categories: { PTS: 'strong' },
  strengths: ['scoring'],
  weaknesses: ['blocks'],
  suggestions: ['add a center'],
};

describe('GET /api/ai/team-analysis cache behavior', () => {
  it('serves a fresh cache hit as-is, without a stale marker', async () => {
    // arrange
    mockAnalysisPreamble();
    queryMock.mockResolvedValueOnce(pgResult([{ analysis: ANALYSIS }]));

    // act
    const res = await request(app)
      .get('/api/ai/team-analysis')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.strengths).toEqual(['scoring']);
    expect(res.body.stale).toBeUndefined();
  });

  it('serves the previous analysis with stale:true when the cache key rotated', async () => {
    // arrange — key-match lookup misses, the by-user fallback finds the old row
    mockAnalysisPreamble();
    queryMock
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([{ analysis: ANALYSIS, created_at: '2026-06-09T12:00:00Z' }]));

    // act
    const res = await request(app)
      .get('/api/ai/team-analysis')
      .set('Authorization', bearerFor(1));

    // assert — the old analysis comes back immediately, flagged for the
    // client to regenerate in the background.
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.cached_at).toBe('2026-06-09T12:00:00Z');
    expect(res.body.strengths).toEqual(['scoring']);
  });
});

const SUGGESTIONS = {
  trade_targets: [{ name: 'Trade Guy', reasoning: 'helps blocks' }],
  waiver_pickups: [{ name: 'Waiver Guy', reasoning: 'helps steals' }],
  summary: 'Chase defense.',
};

// query order for /waiver-suggestions: roster count, getRosterHash,
// getUserPreferences, then the cache lookups.
function mockWaiverPreamble(): void {
  queryMock
    .mockResolvedValueOnce(pgResult([{ n: 1 }]))
    .mockResolvedValueOnce(pgResult([{ player_id: 1 }]))
    .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]));
}

describe('GET /api/ai/waiver-suggestions cache behavior', () => {
  it('serves a fresh cache hit without a stale marker', async () => {
    // arrange
    mockWaiverPreamble();
    queryMock.mockResolvedValueOnce(
      pgResult([{ suggestions: SUGGESTIONS, created_at: '2026-06-10T08:00:00Z' }])
    );

    // act
    const res = await request(app)
      .get('/api/ai/waiver-suggestions')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.stale).toBeUndefined();
    expect(res.body.trade_targets).toHaveLength(1);
  });

  it('serves expired suggestions with stale:true instead of blocking', async () => {
    // arrange — fresh lookup misses (ttl/key), fallback finds the old row
    mockWaiverPreamble();
    queryMock
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(
        pgResult([{ suggestions: SUGGESTIONS, created_at: '2026-06-09T12:00:00Z' }])
      );

    // act
    const res = await request(app)
      .get('/api/ai/waiver-suggestions')
      .set('Authorization', bearerFor(1));

    // assert
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.cached_at).toBe('2026-06-09T12:00:00Z');
    expect(res.body.waiver_pickups).toHaveLength(1);
  });
});
