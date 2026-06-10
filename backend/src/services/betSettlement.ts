import { profitOnWin } from './oddsMath.js';

/**
 * Pure bet settlement and ledger math. The line convention matches the bets
 * table: a spread line is stored relative to the SELECTED side (home -6.5
 * means the home team must win by 7+; away +6.5 means the away team can lose
 * by up to 6), and a total stores the posted number. Moneyline has no line.
 */

export type BetMarket = 'spread' | 'total' | 'moneyline';
export type BetSelection = 'home' | 'away' | 'over' | 'under';
export type BetOutcome = 'won' | 'lost' | 'push';
export type BetStatus = 'pending' | BetOutcome;

export interface SettleableBet {
  market: BetMarket;
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

/** signed profit for a bet: won → payout, lost → -stake, push/pending → 0 */
export function betProfit(status: BetStatus, stake: number, americanOdds: number): number {
  if (status === 'won') return profitOnWin(stake, americanOdds);
  if (status === 'lost') return -stake;
  return 0;
}

export interface LedgerSummary {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  total_staked: number;
  profit: number;
  roi: number;
}

interface LedgerBet {
  status: BetStatus;
  stake: number;
  american_odds: number;
}

/**
 * Aggregates a user's bets into the record/ROI stat row. ROI is profit over
 * SETTLED stake only — pending bets haven't resolved, so counting their stake
 * would understate performance.
 */
export function summarizeLedger(bets: LedgerBet[]): LedgerSummary {
  const summary: LedgerSummary = {
    wins: 0,
    losses: 0,
    pushes: 0,
    pending: 0,
    total_staked: 0,
    profit: 0,
    roi: 0,
  };

  let settledStake = 0;
  for (const bet of bets) {
    summary.total_staked += bet.stake;
    if (bet.status === 'won') summary.wins += 1;
    else if (bet.status === 'lost') summary.losses += 1;
    else if (bet.status === 'push') summary.pushes += 1;
    else summary.pending += 1;

    if (bet.status !== 'pending') {
      settledStake += bet.stake;
      summary.profit += betProfit(bet.status, bet.stake, bet.american_odds);
    }
  }

  summary.total_staked = Math.round(summary.total_staked * 100) / 100;
  summary.profit = Math.round(summary.profit * 100) / 100;
  summary.roi = settledStake > 0 ? summary.profit / settledStake : 0;
  return summary;
}
