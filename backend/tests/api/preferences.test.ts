import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';
import { pgResult } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

describe('PATCH /api/preferences', () => {
  it('rejects requests without a token', async () => {
    const res = await request(app).patch('/api/preferences').send({});

    expect(res.status).toBe(401);
  });

  it('merges a betting-only patch over existing fantasy preferences', async () => {
    const stored = { risk_tolerance: 'balanced', league_size: 12 };
    queryMock
      .mockResolvedValueOnce(pgResult([{ ai_preferences: stored }]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]));

    const res = await request(app)
      .patch('/api/preferences')
      .set('Authorization', bearerFor(7))
      .send({ betting: { risk_appetite: 'aggressive' } });

    expect(res.status).toBe(200);
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('UPDATE users SET ai_preferences')
    );
    expect(updateCall).toBeDefined();
    const [, params] = updateCall!;
    const saved = JSON.parse((params as string[])[0]);
    expect(saved.risk_tolerance).toBe('balanced');
    expect(saved.league_size).toBe(12);
    expect(saved.betting).toEqual({ risk_appetite: 'aggressive' });
    expect((params as unknown[])[1]).toBe(7);
  });

  it('preserves stored betting prefs when a fantasy-only patch arrives', async () => {
    const stored = { betting: { risk_appetite: 'conservative' } };
    queryMock
      .mockResolvedValueOnce(pgResult([{ ai_preferences: stored }]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]));

    const res = await request(app)
      .patch('/api/preferences')
      .set('Authorization', bearerFor(7))
      .send({ risk_tolerance: 'high_upside' });

    expect(res.status).toBe(200);
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('UPDATE users SET ai_preferences')
    );
    const saved = JSON.parse((updateCall![1] as string[])[0]);
    expect(saved.risk_tolerance).toBe('high_upside');
    expect(saved.betting).toEqual({ risk_appetite: 'conservative' });
  });

  it('strips junk from the betting sub-object', async () => {
    queryMock
      .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]))
      .mockResolvedValueOnce(pgResult([]))
      .mockResolvedValueOnce(pgResult([{ ai_preferences: {} }]));

    const res = await request(app)
      .patch('/api/preferences')
      .set('Authorization', bearerFor(7))
      .send({
        betting: {
          risk_appetite: 'yolo', // invalid enum
          preferred_markets: ['spread', 'crypto', 'parlay'], // one junk entry
          extra_notes: '  I like unders  ',
          hacker_field: 'nope',
        },
      });

    expect(res.status).toBe(200);
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('UPDATE users SET ai_preferences')
    );
    const saved = JSON.parse((updateCall![1] as string[])[0]);
    expect(saved.betting).toEqual({
      preferred_markets: ['spread', 'parlay'],
      extra_notes: 'I like unders',
    });
  });
});
