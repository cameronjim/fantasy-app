import type { NumericLike } from './core';
import type { BaselineDescriptor, PredictionRun, SlatePool } from './predictions';

export interface SlateProjectedCategories {
  reb: NumericLike | null;
  ast: NumericLike | null;
  stl: NumericLike | null;
  blk: NumericLike | null;
  tov: NumericLike | null;
  fg3m: NumericLike | null;
}

export interface SlatePlayer {
  nba_player_id: string;
  name: string;
  // true when `name` is a stand-in built from the NBA id; render it as an id, not a person.
  name_is_placeholder: boolean;
  team_abbr: string | null;
  prob_active: NumericLike | null;
  // unconditional: availability is already priced in.
  proj_pts: NumericLike | null;
  proj_min_p50: NumericLike | null;
  projected: SlateProjectedCategories;
  // null means he has too little history to have a usual, which is not "unchanged".
  usual_min: NumericLike | null;
  usual_pts: NumericLike | null;
  // min_vs_usual compares two per-appearance numbers; pts_vs_usual also carries availability.
  min_vs_usual: NumericLike | null;
  pts_vs_usual: NumericLike | null;
  baseline_games: number;
  // summed z-scores across the nine categories; 0 is an average night on the slate.
  impact: NumericLike | null;
  spotlight: boolean;
  slate_spotlight: boolean;
  // the current injury report, which can be newer than the projection.
  injury_status?: string | null;
  injury_status_raw?: string | null;
  injury_detail?: string | null;
  injury_as_of?: string | null;
  injury_changed_after_run?: boolean;
}

export interface SlateGame {
  nba_game_id: string;
  game_status: string | null;
  home_team_id: string | null;
  home_team_abbr: string | null;
  away_team_id: string | null;
  away_team_abbr: string | null;
  top_impact: NumericLike | null;
  players: SlatePlayer[];
}

export interface SlateResponse {
  date: string;
  run: PredictionRun | null;
  pool: SlatePool;
  baseline: BaselineDescriptor;
  games: SlateGame[];
}
