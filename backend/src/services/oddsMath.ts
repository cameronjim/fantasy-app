/**
 * Pure betting math: American odds conversions, implied probability, and
 * parlay combination. No I/O — everything here is unit-testable with plain
 * numbers.
 *
 * American odds: -110 means risk 110 to win 100; +150 means risk 100 to win
 * 150. Implied probability includes the book's vig, so it overstates the true
 * chance slightly — that's why edges vs. implied probability are meaningful.
 */

/** -110 → 1.909..., +150 → 2.5 */
export function americanToDecimal(odds: number): number {
  if (odds > 0) return 1 + odds / 100;
  return 1 + 100 / Math.abs(odds);
}

/** inverse of americanToDecimal, rounded to an integer price */
export function decimalToAmerican(decimal: number): number {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

/** -110 → 0.5238, +150 → 0.4 */
export function americanToImpliedProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

export interface ParlayOdds {
  american: number;
  impliedProb: number;
}

/** combined price of a parlay: decimal odds multiply across legs */
export function combineParlay(legOdds: number[]): ParlayOdds {
  const decimal = legOdds.reduce((acc, odds) => acc * americanToDecimal(odds), 1);
  return {
    american: decimalToAmerican(decimal),
    impliedProb: 1 / decimal,
  };
}
