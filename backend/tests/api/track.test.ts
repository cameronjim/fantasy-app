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

describe('POST /api/track/pageview', () => {
  it('returns 400 when path is missing', async () => {
    // act
    const res = await request(app).post('/api/track/pageview').send({});

    // assert
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path/);
  });

  it('returns 400 when path is not app-internal', async () => {
    // act
    const res = await request(app)
      .post('/api/track/pageview')
      .send({ path: 'https://evil.example.com' });

    // assert
    expect(res.status).toBe(400);
  });

  it('returns 400 when path carries a query string', async () => {
    // act — reset-password tokens travel in query strings; they must never
    // be persisted to analytics.
    const res = await request(app)
      .post('/api/track/pageview')
      .send({ path: '/reset-password?token=secret' });

    // assert
    expect(res.status).toBe(400);
  });

  it('returns 400 when path exceeds 300 characters', async () => {
    // act
    const res = await request(app)
      .post('/api/track/pageview')
      .send({ path: '/' + 'a'.repeat(300) });

    // assert
    expect(res.status).toBe(400);
  });

  it('records an anonymous view with a null user_id', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/track/pageview')
      .set('User-Agent', 'test-browser')
      .send({ path: '/betting' });

    // assert
    expect(res.status).toBe(204);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([null, '/betting', null, 'test-browser']);
  });

  it('attributes the view to the jwt user when a token is sent', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/track/pageview')
      .set('Authorization', bearerFor(42))
      .send({ path: '/fantasy' });

    // assert
    expect(res.status).toBe(204);
    const [, params] = queryMock.mock.calls[0];
    expect(params?.[0]).toBe(42);
    expect(params?.[1]).toBe('/fantasy');
  });

  it('treats an invalid token as anonymous instead of rejecting', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/track/pageview')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .send({ path: '/' });

    // assert
    expect(res.status).toBe(204);
    const [, params] = queryMock.mock.calls[0];
    expect(params?.[0]).toBeNull();
  });

  it('truncates an oversized referrer instead of rejecting', async () => {
    // arrange
    queryMock.mockResolvedValueOnce(pgResult([]));

    // act
    const res = await request(app)
      .post('/api/track/pageview')
      .send({ path: '/', referrer: 'r'.repeat(500) });

    // assert
    expect(res.status).toBe(204);
    const [, params] = queryMock.mock.calls[0];
    expect((params?.[2] as string).length).toBe(300);
  });

  it('still returns 204 when the insert fails', async () => {
    // arrange — analytics must never break the app for the visitor.
    queryMock.mockRejectedValueOnce(new Error('db down'));

    // act
    const res = await request(app).post('/api/track/pageview').send({ path: '/' });

    // assert
    expect(res.status).toBe(204);
  });
});
