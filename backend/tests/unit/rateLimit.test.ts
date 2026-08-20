import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../../src/db.js';
import { recordHit, rateLimit } from '../../src/middleware/rateLimit.js';
import { pgResult } from '../helpers/mockDb.js';

const queryMock = vi.mocked(query);

interface ResponseMock {
  status: Mock;
  json: Mock;
}

function mockResponse(): Response & ResponseMock {
  const res = {} as Response & ResponseMock;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function mockRequest(ip = '1.2.3.4'): Request {
  return { ip, headers: {} } as unknown as Request;
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('recordHit', () => {
  it('returns the running window count and keys the bucket + window', async () => {
    queryMock.mockResolvedValueOnce(pgResult([{ count: 4 }]));

    const count = await recordHit('login:1.2.3.4', 900);

    expect(count).toBe(4);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['login:1.2.3.4', 900]);
  });
});

describe('rateLimit middleware', () => {
  const realNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it('is a no-op under NODE_ENV=test (counter untouched)', async () => {
    process.env.NODE_ENV = 'test';
    const mw = rateLimit({ scope: 'login', limit: 5, windowSeconds: 900 });
    const next = vi.fn() as NextFunction & Mock;

    await mw(mockRequest(), mockResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows a request while under the limit', async () => {
    process.env.NODE_ENV = 'production';
    queryMock.mockResolvedValueOnce(pgResult([{ count: 3 }]));
    const mw = rateLimit({ scope: 'login', limit: 5, windowSeconds: 900 });
    const res = mockResponse();
    const next = vi.fn() as NextFunction & Mock;

    await mw(mockRequest(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects with 429 once the count exceeds the limit', async () => {
    process.env.NODE_ENV = 'production';
    queryMock.mockResolvedValueOnce(pgResult([{ count: 6 }]));
    const mw = rateLimit({ scope: 'login', limit: 5, windowSeconds: 900 });
    const res = mockResponse();
    const next = vi.fn() as NextFunction & Mock;

    await mw(mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open when the counter query errors', async () => {
    process.env.NODE_ENV = 'production';
    queryMock.mockRejectedValueOnce(new Error('db unavailable'));
    const mw = rateLimit({ scope: 'login', limit: 5, windowSeconds: 900 });
    const res = mockResponse();
    const next = vi.fn() as NextFunction & Mock;

    await mw(mockRequest(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('keys the bucket via keyFor when provided', async () => {
    process.env.NODE_ENV = 'production';
    queryMock.mockResolvedValueOnce(pgResult([{ count: 1 }]));
    const mw = rateLimit({
      scope: 'ai',
      limit: 200,
      windowSeconds: 86_400,
      keyFor: () => '42',
    });
    const next = vi.fn() as NextFunction & Mock;

    await mw(mockRequest(), mockResponse(), next);

    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['ai:42', 86_400]);
  });
});
