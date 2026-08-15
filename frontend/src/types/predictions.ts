import type { NumericLike } from './core';

export interface PredictionRun {
  model_version: string;
  predicted_at: string | null;
}

export interface PredictionRunMeta extends PredictionRun {
  id: number;
  feature_version: string | null;
  // the information boundary: the run could not see anything at or after it.
  forecast_cutoff_at: string | null;
  horizon: string | null;
}

export interface PredictionStatLine {
  // expected/p10/p50/p90 are conditional on him playing; unconditional prices in sitting.
  expected: NumericLike | null;
  p10: NumericLike | null;
  p50: NumericLike | null;
  p90: NumericLike | null;
  unconditional: NumericLike | null;
}

export interface UpcomingGamePrediction {
  nba_game_id: string;
  game_date: string;
  opponent_abbr: string | null;
  is_home: boolean | null;
  game_status: string | null;
  // a model probability, never an official injury designation.
  prob_active: NumericLike | null;
  prob_active_model: NumericLike | null;
  // an open record, not a fixed union: a fixed list would hide newly emitted stats.
  stats: Record<string, PredictionStatLine>;
}

export interface PlayerPredictionsResponse {
  player_id: number;
  nba_player_id: string | null;
  run: PredictionRunMeta | null;
  // every stat key present across `games`, in the order to render columns.
  stats: string[];
  games: UpcomingGamePrediction[];
}

// the reference set impact z-scores are measured against, described by the server
// so no page hardcodes the definition of a number it displays.
export interface SlatePool {
  key: string;
  label: string;
  definition: string;
  sample_size: number;
}

export interface BaselineDescriptor {
  window_games: number;
  min_games: number;
  notable_min_delta: number;
  label: string;
  definition: string;
}
