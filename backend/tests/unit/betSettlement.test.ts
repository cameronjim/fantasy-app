import { describe, it, expect } from 'vitest';
import {
  settleBet,
  summarizeLedger,
  type SettleableBet,
} from '../../src/services/betSettlement.js';

const spread = (selection: 'home' | 'away', line: number): SettleableBet => ({
  market: 'spread',
  selection,
  line,
});

const total = (selection: 'over' | 'under', line: number): SettleableBet => ({
  market: 'total',
  selection,
  line,
});

const moneyline = (selection: 'home' | 'away'): SettleableBet => ({
  market: 'moneyline',
  selection,
  line: null,
});

describe('settleBet — spread', () => {
  it('wins when the favorite covers', () => {
    // act + assert — home -6.5, home wins by 10
    expect(settleBet(spread('home', -6.5), 110, 100)).toBe('won');
  });

  it('loses when the favorite wins but fails to cover', () => {
    // act + assert — home -6.5, home wins by 4
    expect(settleBet(spread('home', -6.5), 104, 100)).toBe('lost');
  });

  it('wins for the dog side getting points even in a loss', () => {
    // act + assert — away +6.5, away loses by 4
    expect(settleBet(spread('away', 6.5), 104, 100)).toBe('won');
  });

  it('pushes on an exact integer-line margin', () => {
    // act + assert — home -6, home wins by exactly 6
    expect(settleBet(spread('home', -6), 106, 100)).toBe('push');
  });
});

describe('settleBet — total', () => {
  it('settles over and under against the posted total', () => {
    // act + assert — line 220.5, final total 225
    expect(settleBet(total('over', 220.5), 115, 110)).toBe('won');
    expect(settleBet(total('under', 220.5), 115, 110)).toBe('lost');
  });

  it('settles the under when the game lands below the line', () => {
    // act + assert — line 220.5, final total 210
    expect(settleBet(total('under', 220.5), 105, 105)).toBe('won');
    expect(settleBet(total('over', 220.5), 105, 105)).toBe('lost');
  });

  it('pushes when the total lands exactly on an integer line', () => {
    // act + assert — line 220, final total 220
    expect(settleBet(total('over', 220), 110, 110)).toBe('push');
    expect(settleBet(total('under', 220), 110, 110)).toBe('push');
  });
});

describe('settleBet — moneyline', () => {
  it('settles by which side scored more', () => {
    // act + assert
    expect(settleBet(moneyline('home'), 110, 100)).toBe('won');
    expect(settleBet(moneyline('away'), 110, 100)).toBe('lost');
    expect(settleBet(moneyline('away'), 100, 110)).toBe('won');
  });
});

describe('summarizeLedger', () => {
  it('counts the record across statuses', () => {
    // arrange
    const bets = [
      { status: 'won' as const },
      { status: 'won' as const },
      { status: 'lost' as const },
      { status: 'push' as const },
      { status: 'pending' as const },
    ];

    // act
    const summary = summarizeLedger(bets);

    // assert
    expect(summary).toEqual({ wins: 2, losses: 1, pushes: 1, pending: 1 });
  });

  it('returns all zeros for an empty ledger', () => {
    // act + assert
    expect(summarizeLedger([])).toEqual({ wins: 0, losses: 0, pushes: 0, pending: 0 });
  });
});
