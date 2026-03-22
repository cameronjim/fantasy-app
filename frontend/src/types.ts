export interface Player {
  id: number;
  name: string;
  team: string;
  position: string;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  fg_pct: number;
  three_pct: number;
  ft_pct: number;
  three_pm: number;
  tov: number;
  mpg: number;
  gp: number;
  injury_status: string | null;
  injury_detail: string | null;
}

export interface Team {
  id: number;
  name: string;
  abbreviation: string;
  wins: number;
  losses: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  fg_pct: number;
  three_pct: number;
  ft_pct: number;
  tov: number;
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
