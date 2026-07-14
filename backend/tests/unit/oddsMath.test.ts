import { describe, it, expect } from 'vitest';
import {
  americanToDecimal,
  decimalToAmerican,
  americanToImpliedProb,
  combineParlay,
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
