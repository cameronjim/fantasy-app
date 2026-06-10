import { describe, it, expect } from 'vitest';
import {
  americanToDecimal,
  decimalToAmerican,
  americanToImpliedProb,
  combineParlay,
  kellyFraction,
  kellyStake,
  profitOnWin,
} from '../../src/services/oddsMath.js';

describe('americanToDecimal', () => {
  it('converts negative and positive american odds', () => {
    // act + assert
    expect(americanToDecimal(-110)).toBeCloseTo(1.909, 3);
    expect(americanToDecimal(+150)).toBeCloseTo(2.5, 5);
    expect(americanToDecimal(-200)).toBeCloseTo(1.5, 5);
    expect(americanToDecimal(+100)).toBeCloseTo(2.0, 5);
  });
});

describe('decimalToAmerican', () => {
  it('round-trips american odds through decimal', () => {
    // act + assert
    expect(decimalToAmerican(americanToDecimal(-110))).toBe(-110);
    expect(decimalToAmerican(americanToDecimal(+150))).toBe(150);
    expect(decimalToAmerican(americanToDecimal(-200))).toBe(-200);
    expect(decimalToAmerican(americanToDecimal(+100))).toBe(100);
  });
});

describe('americanToImpliedProb', () => {
  it('computes the implied probability with vig', () => {
    // act + assert
    expect(americanToImpliedProb(-110)).toBeCloseTo(0.5238, 4);
    expect(americanToImpliedProb(+150)).toBeCloseTo(0.4, 5);
    expect(americanToImpliedProb(-200)).toBeCloseTo(0.6667, 4);
    expect(americanToImpliedProb(+100)).toBeCloseTo(0.5, 5);
  });
});

describe('combineParlay', () => {
  it('combines two standard -110 legs into roughly +264', () => {
    // act
    const result = combineParlay([-110, -110]);

    // assert
    expect(result.american).toBe(264); // (1.9090...)^2 = 3.6446 → +264
    expect(result.impliedProb).toBeCloseTo(0.2744, 3);
  });

  it('returns a single leg unchanged', () => {
    // act
    const result = combineParlay([+150]);

    // assert
    expect(result.american).toBe(150);
    expect(result.impliedProb).toBeCloseTo(0.4, 5);
  });
});

describe('kellyFraction', () => {
  it('computes the known case p=0.55 at -110', () => {
    // act
    const f = kellyFraction(0.55, -110);

    // assert — b = 0.9090..., f* = (0.9090*0.55 - 0.45) / 0.9090 ≈ 0.055
    expect(f).toBeCloseTo(0.055, 3);
  });

  it('clamps to zero when the edge is negative', () => {
    // act + assert — implied prob of -110 is 52.38%, so 50% is a losing bet
    expect(kellyFraction(0.5, -110)).toBe(0);
  });
});

describe('kellyStake', () => {
  it('applies quarter-kelly by default and rounds to cents', () => {
    // arrange
    const bankroll = 1000;

    // act
    const stake = kellyStake(0.55, -110, bankroll);

    // assert — 0.055 * 0.25 * 1000 = 13.75
    expect(stake).toBeCloseTo(13.75, 2);
  });

  it('returns zero for a negative-edge bet', () => {
    // act + assert
    expect(kellyStake(0.4, -110, 1000)).toBe(0);
  });
});

describe('profitOnWin', () => {
  it('computes profit excluding the returned stake', () => {
    // act + assert
    expect(profitOnWin(110, -110)).toBeCloseTo(100, 2);
    expect(profitOnWin(100, +150)).toBeCloseTo(150, 2);
  });
});
