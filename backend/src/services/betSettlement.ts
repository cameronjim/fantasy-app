import { profitOnWin } from './oddsMath.js';


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

  const total = homeScore + awayScore;
  const line = bet.line ?? 0;
  if (total === line) return 'push';
  const overWon = total > line;
  return (bet.selection === 'over') === overWon ? 'won' : 'lost';
}

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
