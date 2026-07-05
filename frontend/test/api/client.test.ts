import { describe, it, expect, beforeEach } from 'vitest';
import { setAuthToken, getAuthToken } from '../../src/api/client';

describe('auth token storage', () => {
  beforeEach(() => {
    setAuthToken(null);
  });

  it('persists the token to localStorage when set', () => {
    // arrange + act
    setAuthToken('abc.def.ghi');

    // assert
    expect(getAuthToken()).toBe('abc.def.ghi');
    expect(localStorage.getItem('auth_token')).toBe('abc.def.ghi');
  });

  it('clears the token from localStorage when set to null', () => {
    // arrange
    setAuthToken('a-token');

    // act
    setAuthToken(null);

    // assert
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem('auth_token')).toBeNull();
  });
});
