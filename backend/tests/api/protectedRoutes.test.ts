import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';
import { pgResult } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

describe('auth gating on /api/fantasy and /api/ai', () => {
  it('rejects /api/fantasy/roster without a Bearer token', async () => {
    const res = await request(app).get('/api/fantasy/roster');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects /api/ai/team-analysis without a Bearer token', async () => {
    const res = await request(app).get('/api/ai/team-analysis');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it.each([
    ['get', '/api/betting/picks'],
    ['get', '/api/betting/bets'],
    ['post', '/api/betting/bets'],
    ['patch', '/api/betting/bets/1'],
    ['delete', '/api/betting/bets/1'],
  ] as const)('rejects %s %s without a Bearer token', async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects /api/fantasy/roster with an invalid token', async () => {
    const res = await request(app)
      .get('/api/fantasy/roster')
      .set('Authorization', 'Bearer not-a-real-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  it('allows /api/fantasy/roster with a valid token and binds the jwt user id', async () => {
    queryMock.mockResolvedValueOnce(pgResult([]));

    const res = await request(app)
      .get('/api/fantasy/roster')
      .set('Authorization', bearerFor(123));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([123]);
  });
});
