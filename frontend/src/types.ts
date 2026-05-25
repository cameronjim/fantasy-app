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
