import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';

describe('GET /api/health', () => {
  it('returns 200 and a JSON status payload', async () => {
    // arrange — db is mocked globally in setup.ts; the route doesn't query it.
    // act
    const res = await request(app).get('/api/health');

    // assert
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('sends helmet security headers on responses', async () => {
    // act
    const res = await request(app).get('/api/health');

    // assert — helmet sets these; their presence confirms the middleware runs.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers).toHaveProperty('x-dns-prefetch-control');
  });
});
