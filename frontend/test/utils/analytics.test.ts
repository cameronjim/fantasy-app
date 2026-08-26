import { describe, it, expect } from 'vitest';
import { formatGameDate } from '../../src/utils/analytics';

describe('formatGameDate', () => {
  it('reads a calendar day on the local calendar, not as UTC midnight', () => {
    // arrange + act — parsing "2026-01-15" with `new Date()` yields Jan 14 for
    // every reader west of Greenwich, so this holds in any runner timezone.
    const label = formatGameDate('2026-01-15');

    // assert
    expect(label).toBe('Jan 15');
  });

  it('formats a day either side of a month boundary', () => {
    expect(formatGameDate('2026-02-04')).toBe('Feb 4');
    expect(formatGameDate('2025-12-31')).toBe('Dec 31');
  });

  it('passes an unparseable string through untouched', () => {
    expect(formatGameDate('not-a-date')).toBe('not-a-date');
    expect(formatGameDate('')).toBe('');
  });
});
