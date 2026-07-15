export interface Player {
  id: number;
  name: string;
  team: string;
  position: string;
  points_per_game: number;
  rebounds_per_game: number;
  assists_per_game: number;
  steals_per_game: number;
  blocks_per_game: number;
  field_goal_percentage: number;
  three_point_percentage: number;
  free_throw_percentage: number;
  three_pointers_made: number;
  turnovers_per_game: number;
  minutes_per_game: number;
  games_played: number;
  injury_status: string | null;
  injury_detail: string | null;
  headshot_url?: string;
  fantasy_score?: number | null;
  fantasy_rank?: number | null;
}

export interface Team {
  id: number;
  name: string;
  abbreviation: string;
  conference: string;
  division: string;
  wins: number;
  losses: number;
  points_per_game: number;
  rebounds_per_game: number;
  assists_per_game: number;
  steals_per_game: number;
  blocks_per_game: number;
  field_goal_percentage: number;
  three_point_percentage: number;
  free_throw_percentage: number;
  turnovers_per_game: number;
  defensive_rating: number;
  offensive_rating: number;
  net_rating: number;
}

export interface Game {
  id: number | string;
  nba_game_id?: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  status: string;
  game_date: string;
  period?: number;
  game_clock?: string;
}

export interface RosterPlayer extends Player {
  roster_id: number;
  player_id: number;
  added_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  message: string;
}

export interface TeamAnalysis {
  categories: Record<string, 'strong' | 'average' | 'weak'>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

export type BetMarket = 'spread' | 'total' | 'moneyline' | 'prop' | 'parlay' | 'custom';
export type StraightMarket = 'spread' | 'total' | 'moneyline';
export type BetSelection = 'home' | 'away' | 'over' | 'under';
export type BetStatus = 'pending' | 'won' | 'lost' | 'push';

export interface SpreadMarket {
  home_line: number;
  away_line: number;
  home_price: number;
  away_price: number;
  home_implied: number;
  away_implied: number;
}

export interface TotalMarket {
  line: number;
  over_price: number;
  under_price: number;
  over_implied: number;
  under_implied: number;
}

export interface MoneylineMarket {
  home: number;
  away: number;
  home_implied: number;
  away_implied: number;
}

export interface BettingGame {
  nba_game_id: string;
  home_team: string;
  away_team: string;
  home_abbrev: string;
  away_abbrev: string;
  game_date: string;
  tipoff: string;
  provider: string;
  markets: {
    spread?: SpreadMarket;
    total?: TotalMarket;
    moneyline?: MoneylineMarket;
  };
}

export interface BettingPick {
  game_id: string;
  category: 'best_value' | 'safe' | 'hail_mary';
  market: StraightMarket;
  selection: BetSelection;
  matchup: string;
  game_date: string;
  tipoff: string;
  selection_label: string;
  line: number | null;
  american_odds: number;
  implied_prob: number;
  estimated_win_prob: number;
  edge: number;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface ParlayLeg {
  game_id: string;
  market: StraightMarket;
  selection: BetSelection;
  selection_label: string;
  matchup: string;
  american_odds: number;
}

export interface ParlaySuggestion {
  legs: ParlayLeg[];
  combined_american: number;
  combined_implied_prob: number;
  rationale: string;
  ev_note: string;
}

export interface BettingPicksResponse {
  picks: BettingPick[];
  parlay: ParlaySuggestion | null;
  summary: string;
  cached?: boolean;
  cached_at?: string;
  no_games?: boolean;
}

export type WagerType = 'cash' | 'bonus_bet' | 'odds_boost';

export interface Bet {
  id: number;
  market: BetMarket;
  nba_game_id: string | null;
  home_team: string | null;
  away_team: string | null;
  game_date: string | null;
  selection: BetSelection | null;
  line: number | null;
  american_odds: number | null;
  description: string | null;
  stake: number | null;
  wager_type: WagerType;
  status: BetStatus;
  created_at: string;
  settled_at: string | null;
  // money result, computed server-side: null while pending or without a stake
  net: number | null;
}

export interface NewBet {
  market: BetMarket;
  nba_game_id?: string;
  selection?: BetSelection;
  line?: number | null;
  american_odds?: number | null;
  description?: string;
  stake: number;
  wager_type?: WagerType;
}

/** display fields for an optimistic ledger row before the server confirms */
export type NewBetGameRef = Pick<Bet, 'home_team' | 'away_team' | 'game_date'>;

export interface LedgerSummary {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  net: number;
}
