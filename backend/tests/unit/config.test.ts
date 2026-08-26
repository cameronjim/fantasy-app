import { describe, it, expect } from 'vitest';
import { validateAuthSecret } from '../../src/config.js';

describe('validateAuthSecret', () => {
  it('throws when the secret is missing', () => {
    expect(() => validateAuthSecret(undefined)).toThrow(/at least 32/);
  });

  it('throws when the secret is shorter than 32 characters', () => {
    expect(() => validateAuthSecret('too-short-secret')).toThrow(/at least 32/);
  });

  it('throws when the secret is a known placeholder', () => {
    const placeholder = 'replace-with-a-long-random-secret';

    expect(placeholder.length).toBeGreaterThanOrEqual(32);
    expect(() => validateAuthSecret(placeholder)).toThrow(/placeholder/);
  });

  it('accepts a sufficiently long, non-placeholder secret', () => {
    expect(() => validateAuthSecret('a'.repeat(40))).not.toThrow();
  });
});
