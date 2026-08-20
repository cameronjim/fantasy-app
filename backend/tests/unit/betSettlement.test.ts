import { describe, it, expect } from 'vitest';
import {
  settleBet,
  summarizeLedger,
  betNet,
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
    expect(settleBet(spread('home', -6.5), 110, 100)).toBe('won');
  });

  it('loses when the favorite wins but fails to cover', () => {
    expect(settleBet(spread('home', -6.5), 104, 100)).toBe('lost');
  });

  it('wins for the dog side getting points even in a loss', () => {
    expect(settleBet(spread('away', 6.5), 104, 100)).toBe('won');
  });

  it('pushes on an exact integer-line margin', () => {
    expect(settleBet(spread('home', -6), 106, 100)).toBe('push');
  });
});

describe('settleBet — total', () => {
  it('settles over and under against the posted total', () => {
    expect(settleBet(total('over', 220.5), 115, 110)).toBe('won');
    expect(settleBet(total('under', 220.5), 115, 110)).toBe('lost');
  });

  it('settles the under when the game lands below the line', () => {
    expect(settleBet(total('under', 220.5), 105, 105)).toBe('won');
    expect(settleBet(total('over', 220.5), 105, 105)).toBe('lost');
  });

  it('pushes when the total lands exactly on an integer line', () => {
    expect(settleBet(total('over', 220), 110, 110)).toBe('push');
    expect(settleBet(total('under', 220), 110, 110)).toBe('push');
  });
});

describe('settleBet — moneyline', () => {
  it('settles by which side scored more', () => {
    expect(settleBet(moneyline('home'), 110, 100)).toBe('won');
    expect(settleBet(moneyline('away'), 110, 100)).toBe('lost');
    expect(settleBet(moneyline('away'), 100, 110)).toBe('won');
  });
});

describe('betNet', () => {
  it('returns winnings on a won bet regardless of wager kind', () => {
    expect(betNet('won', 'cash', 110, -110)).toBeCloseTo(100, 2);
    expect(betNet('won', 'bonus_bet', 110, -110)).toBeCloseTo(100, 2);
    expect(betNet('won', 'odds_boost', 100, 150)).toBeCloseTo(150, 2);
  });

  it('costs the stake on a cash loss but nothing on a bonus-bet loss', () => {
    expect(betNet('lost', 'cash', 50, -110)).toBe(-50);
    expect(betNet('lost', 'odds_boost', 50, -110)).toBe(-50);
    expect(betNet('lost', 'bonus_bet', 50, -110)).toBe(0);
  });

  it('is zero on a push and null while pending or without money noted', () => {
    expect(betNet('push', 'cash', 50, -110)).toBe(0);
    expect(betNet('pending', 'cash', 50, -110)).toBeNull();
    expect(betNet('won', 'cash', null, -110)).toBeNull();
    expect(betNet('won', 'cash', 50, null)).toBeNull();
  });
});

describe('summarizeLedger', () => {
  it('counts the record across statuses', () => {
    const bets = [
      { status: 'won' as const },
      { status: 'won' as const },
      { status: 'lost' as const },
      { status: 'push' as const },
      { status: 'pending' as const },
    ];

    const summary = summarizeLedger(bets);

    expect(summary).toEqual({ wins: 2, losses: 1, pushes: 1, pending: 1 });
  });

  it('returns all zeros for an empty ledger', () => {
    expect(summarizeLedger([])).toEqual({ wins: 0, losses: 0, pushes: 0, pending: 0 });
  });
});
