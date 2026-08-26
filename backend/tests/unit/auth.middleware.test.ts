import { describe, it, expect, vi, type Mock } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, type AuthRequest } from '../../src/middleware/auth.js';

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

function mockRequest(headers: Record<string, string> = {}): Request {
  return { headers } as Request;
}

function mockNext(): NextFunction & Mock {
  return vi.fn() as NextFunction & Mock;
}

describe('requireAuth middleware', () => {
  it('responds 401 when the authorization header is missing', () => {
    const req = mockRequest();
    const res = mockResponse();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when the authorization header is not a bearer token', () => {
    const req = mockRequest({ authorization: 'Basic abc' });
    const res = mockResponse();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when the jwt signature is invalid', () => {
    const badToken = jwt.sign({ userId: 1 }, 'wrong-secret');
    const req = mockRequest({ authorization: `Bearer ${badToken}` });
    const res = mockResponse();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches userId and calls next() when the jwt is valid', () => {
    const token = jwt.sign({ userId: 42 }, process.env.AUTH_SECRET!);
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as AuthRequest).userId).toBe(42);
  });
});
