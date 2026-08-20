import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { query } from '../../src/db.js';
import { bearerFor } from '../helpers/authToken.js';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
});

describe('POST /api/ai/chat input validation', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/ai/chat').send({ message: 'hi' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', bearerFor(1))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it('returns 400 when message is not a string', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', bearerFor(1))
      .send({ message: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });

  it('returns 400 when message exceeds the length cap', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .set('Authorization', bearerFor(1))
      .send({ message: 'x'.repeat(5000) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/4000 characters/i);
  });
});
