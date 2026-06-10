import { profitOnWin } from './oddsMath.js';

/**
 * Pure bet settlement and record math. The line convention matches the bets
 * table: a spread line is stored relative to the SELECTED side (home -6.5
 * means the home team must win by 7+; away +6.5 means the away team can lose
 * by up to 6), and a total stores the posted number. Moneyline has no line.
 *
 * Only straight bets (spread/total/moneyline) settle automatically; prop,
 * parlay, and custom entries are settled by the user.
 */

export type BetMarket = 'spread' | 'total' | 'moneyline' | 'prop' | 'parlay' | 'custom';
export type StraightMarket = 'spread' | 'total' | 'moneyline';
export type BetSelection = 'home' | 'away' | 'over' | 'under';
export type BetOutcome = 'won' | 'lost' | 'push';
export type BetStatus = 'pending' | BetOutcome;
export type WagerType = 'cash' | 'bonus_bet' | 'odds_boost';

export const WAGER_TYPES: WagerType[] = ['cash', 'bonus_bet', 'odds_boost'];

export const STRAIGHT_MARKETS: StraightMarket[] = ['spread', 'total', 'moneyline'];

export interface SettleableBet {
  market: StraightMarket;
  selection: BetSelection;
  line: number | null;
}

export function settleBet(bet: SettleableBet, homeScore: number, awayScore: number): BetOutcome {
  if (bet.market === 'moneyline') {
    const selectedScore = bet.selection === 'home' ? homeScore : awayScore;
    const otherScore = bet.selection === 'home' ? awayScore : homeScore;
    if (selectedScore > otherScore) return 'won';
    if (selectedScore < otherScore) return 'lost';
    // defensive: NBA games can't end tied, but never let a bad row mis-settle
    return 'push';
  }

  if (bet.market === 'spread') {
    const margin =
      bet.selection === 'home' ? homeScore - awayScore : awayScore - homeScore;
    const result = margin + (bet.line ?? 0);
    if (result > 0) return 'won';
    if (result < 0) return 'lost';
    return 'push'; // only possible on integer lines
  }

  // total
  const total = homeScore + awayScore;
  const line = bet.line ?? 0;
  if (total === line) return 'push';
  const overWon = total > line;
  return (bet.selection === 'over') === overWon ? 'won' : 'lost';
}

/**
 * Net money result of a bet, when the user recorded a stake. Null while
 * pending or when no stake/odds were noted. A bonus bet ("free bet" credit
 * from the book) pays winnings only and risks no real money, so a loss
 * costs nothing.
 */
export function betNet(
  status: BetStatus,
  wagerType: WagerType,
  stake: number | null,
  americanOdds: number | null
): number | null {
  if (status === 'pending' || stake == null) return null;
  if (status === 'push') return 0;
  if (status === 'lost') return wagerType === 'bonus_bet' ? 0 : -stake;
  if (americanOdds == null) return null;
  return profitOnWin(stake, americanOdds);
}

export interface LedgerSummary {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
}

/** aggregates a user's bets into the W-L-P record shown above the ledger */
export function summarizeLedger(bets: Array<{ status: BetStatus }>): LedgerSummary {
  const summary: LedgerSummary = { wins: 0, losses: 0, pushes: 0, pending: 0 };
  for (const bet of bets) {
    if (bet.status === 'won') summary.wins += 1;
    else if (bet.status === 'lost') summary.losses += 1;
    else if (bet.status === 'push') summary.pushes += 1;
    else summary.pending += 1;
  }
  return summary;
}
