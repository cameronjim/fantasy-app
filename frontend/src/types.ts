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

export type BetMarket = 'spread' | 'total' | 'moneyline';
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

export interface KellySuggestion {
  full: number;
  quarter: number;
  suggested_stake: number;
}

export interface BettingPick {
  game_id: string;
  category: 'best_value' | 'safe' | 'hail_mary';
  market: BetMarket;
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
  kelly?: KellySuggestion | null;
}

export interface ParlayLeg {
  game_id: string;
  market: BetMarket;
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

export interface Bet {
  id: number;
  nba_game_id: string;
  home_team: string;
  away_team: string;
  game_date: string;
  market: BetMarket;
  selection: BetSelection;
  line: number | null;
  american_odds: number;
  stake: number;
  status: BetStatus;
  created_at: string;
  settled_at: string | null;
  profit: number;
}

export interface NewBet {
  nba_game_id: string;
  market: BetMarket;
  selection: BetSelection;
  line: number | null;
  american_odds: number;
  stake: number;
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
