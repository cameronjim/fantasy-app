/**
 * Pure betting math: American odds conversions, implied probability, parlay
 * combination, and Kelly stake sizing. No I/O — everything here is unit-
 * testable with plain numbers.
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

/** -110 → 0.5238..., +150 → 0.4 */
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

/**
 * Full-Kelly fraction of bankroll: f* = (b*p - q) / b where b is the net
 * decimal payout and q = 1 - p. Negative edge clamps to 0 — never bet a
 * negative-EV line.
 */
export function kellyFraction(winProb: number, americanOdds: number): number {
  const b = americanToDecimal(americanOdds) - 1;
  const f = (b * winProb - (1 - winProb)) / b;
  return Math.max(0, f);
}

/**
 * Suggested stake in dollars. Defaults to quarter-Kelly — full Kelly assumes
 * the win probability estimate is exact, which an AI guess never is.
 */
export function kellyStake(
  winProb: number,
  americanOdds: number,
  bankroll: number,
  fraction = 0.25
): number {
  const stake = kellyFraction(winProb, americanOdds) * fraction * bankroll;
  return Math.round(stake * 100) / 100;
}

/** profit (excluding returned stake) if the bet wins */
export function profitOnWin(stake: number, americanOdds: number): number {
  const profit = stake * (americanToDecimal(americanOdds) - 1);
  return Math.round(profit * 100) / 100;
}
