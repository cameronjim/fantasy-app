import { describe, it, expect } from 'vitest';
import {
  formatAmerican,
  formatPercent,
  formatSignedPercent,
  formatLine,
  formatMoney,
  formatSignedMoney,
} from '../../src/utils/formatOdds';

describe('formatMoney', () => {
  it('formats dollars with the sign outside the symbol', () => {
    // act + assert
    expect(formatMoney(13.75)).toBe('$13.75');
    expect(formatMoney(-50)).toBe('-$50.00');
    expect(formatMoney(0)).toBe('$0.00');
  });
});

describe('formatSignedMoney', () => {
  it('always shows the sign for net results', () => {
    // act + assert
    expect(formatSignedMoney(47.62)).toBe('+$47.62');
    expect(formatSignedMoney(-20)).toBe('-$20.00');
    expect(formatSignedMoney(0)).toBe('+$0.00');
  });
});

describe('formatAmerican', () => {
  it('prefixes positive odds with a plus sign', () => {
    // act + assert
    expect(formatAmerican(150)).toBe('+150');
    expect(formatAmerican(-110)).toBe('-110');
    expect(formatAmerican(100)).toBe('+100');
  });
});

describe('formatPercent', () => {
  it('renders a probability as a one-decimal percent', () => {
    // act + assert
    expect(formatPercent(0.5238)).toBe('52.4%');
    expect(formatPercent(0.4)).toBe('40.0%');
  });
});

describe('formatSignedPercent', () => {
  it('keeps the sign visible for edges', () => {
    // act + assert
    expect(formatSignedPercent(0.067)).toBe('+6.7%');
    expect(formatSignedPercent(-0.02)).toBe('-2.0%');
    expect(formatSignedPercent(0)).toBe('+0.0%');
  });
});

describe('formatLine', () => {
  it('shows plus on positive lines only', () => {
    // act + assert
    expect(formatLine(2.5)).toBe('+2.5');
    expect(formatLine(-2.5)).toBe('-2.5');
    expect(formatLine(0)).toBe('0');
  });
});
