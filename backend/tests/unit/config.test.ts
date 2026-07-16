import { describe, it, expect } from 'vitest';
import { validateAuthSecret } from '../../src/config.js';

describe('validateAuthSecret', () => {
  it('throws when the secret is missing', () => {
    // act + assert
    expect(() => validateAuthSecret(undefined)).toThrow(/at least 32/);
  });

  it('throws when the secret is shorter than 32 characters', () => {
    // act + assert
    expect(() => validateAuthSecret('too-short-secret')).toThrow(/at least 32/);
  });

  it('throws when the secret is a known placeholder', () => {
    // arrange — the .env.example value is 33 chars, so it passes the length
    // check and must be caught by the placeholder check instead.
    const placeholder = 'replace-with-a-long-random-secret';

    // act + assert
    expect(placeholder.length).toBeGreaterThanOrEqual(32);
    expect(() => validateAuthSecret(placeholder)).toThrow(/placeholder/);
  });

  it('accepts a sufficiently long, non-placeholder secret', () => {
    // act + assert
    expect(() => validateAuthSecret('a'.repeat(40))).not.toThrow();
  });
});
