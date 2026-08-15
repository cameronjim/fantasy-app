// pg serializes NUMERIC as a string, so coerce with toStatNumber before math or render.
export type NumericLike = number | string;

export interface Player {
  id: number;
  nba_id?: string | null;
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
  logo_url?: string | null;
}

export interface PlayerSeasonRow {
  nba_player_id: string;
  player_name: string;
  season: string;
  team: string | null;
  games_played: NumericLike | null;
  minutes_per_game: NumericLike | null;
  points_per_game: NumericLike | null;
  rebounds_per_game: NumericLike | null;
  assists_per_game: NumericLike | null;
  steals_per_game: NumericLike | null;
  blocks_per_game: NumericLike | null;
  turnovers_per_game: NumericLike | null;
  field_goal_percentage: NumericLike | null;
  three_point_percentage: NumericLike | null;
  free_throw_percentage: NumericLike | null;
  three_pointers_made: NumericLike | null;
}

export interface TeamSeasonRow {
  nba_team_id: string;
  team_name: string;
  abbreviation: string | null;
  season: string;
  games_played: NumericLike | null;
  wins: NumericLike | null;
  losses: NumericLike | null;
  minutes_per_game: NumericLike | null;
  points_per_game: NumericLike | null;
  rebounds_per_game: NumericLike | null;
  assists_per_game: NumericLike | null;
  steals_per_game: NumericLike | null;
  blocks_per_game: NumericLike | null;
  turnovers_per_game: NumericLike | null;
  field_goal_percentage: NumericLike | null;
  three_point_percentage: NumericLike | null;
  free_throw_percentage: NumericLike | null;
  offensive_rating: NumericLike | null;
  defensive_rating: NumericLike | null;
  net_rating: NumericLike | null;
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
  stale?: boolean;
  cached_at?: string;
}
