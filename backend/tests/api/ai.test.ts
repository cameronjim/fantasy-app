import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

// these all return before any db or Anthropic call, so no mocks are needed.
// the rate limiter is a no-op under NODE_ENV=test (see rateLimit.ts).
describe('POST /api/ai/chat input validation', () => {
  it('rejects an unauthenticated request with 401', async () => {
    // act
    const res = await request(app).post('/api/ai/chat').send({ message: 'hi' });

    // assert
    expect(res.status).toBe(401);
  });

  it('returns 400 when message is missing', async () => {
    // act
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', bearerFor(1))
      .send({});

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it('returns 400 when message is not a string', async () => {
    // act
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', bearerFor(1))
      .send({ message: 42 });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it('returns 400 when message exceeds the length cap', async () => {
    // act
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', bearerFor(1))
      .send({ message: 'x'.repeat(5000) });

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/4000 characters/i);
  });
});
