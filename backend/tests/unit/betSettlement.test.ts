import { describe, it, expect } from 'vitest';
import {
  settleBet,
  betProfit,
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

describe('betProfit', () => {
  it('returns payout on a win, negative stake on a loss, zero otherwise', () => {
    // act + assert
    expect(betProfit('won', 110, -110)).toBeCloseTo(100, 2);
    expect(betProfit('won', 100, +150)).toBeCloseTo(150, 2);
    expect(betProfit('lost', 50, -110)).toBe(-50);
    expect(betProfit('push', 50, -110)).toBe(0);
    expect(betProfit('pending', 50, -110)).toBe(0);
  });
});

describe('summarizeLedger', () => {
  it('aggregates record, profit, and roi over settled stake only', () => {
    // arrange — won 100 @ +150 (+150), lost 50 (-50), push 25 (0), pending 75
    const bets = [
      { status: 'won' as const, stake: 100, american_odds: 150 },
      { status: 'lost' as const, stake: 50, american_odds: -110 },
      { status: 'push' as const, stake: 25, american_odds: -110 },
      { status: 'pending' as const, stake: 75, american_odds: -110 },
    ];

    // act
    const summary = summarizeLedger(bets);

    // assert
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.pushes).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.total_staked).toBe(250);
    expect(summary.profit).toBeCloseTo(100, 2);
    // settled stake = 175; roi = 100 / 175
    expect(summary.roi).toBeCloseTo(0.5714, 3);
  });

  it('guards roi when nothing has settled', () => {
    // act
    const summary = summarizeLedger([
      { status: 'pending', stake: 100, american_odds: -110 },
    ]);

    // assert
    expect(summary.roi).toBe(0);
    expect(summary.profit).toBe(0);
  });

  it('returns all zeros for an empty ledger', () => {
    // act
    const summary = summarizeLedger([]);

    // assert
    expect(summary).toEqual({
      wins: 0, losses: 0, pushes: 0, pending: 0,
      total_staked: 0, profit: 0, roi: 0,
    });
  });
});
