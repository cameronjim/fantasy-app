// widths are explicit because both tables are `table-fixed`, which stops re-sorting from resizing columns.

import type { PlayerSeasonRow } from '../types';

export type SeasonStatKey = Extract<
  keyof PlayerSeasonRow,
  | 'games_played' | 'minutes_per_game' | 'points_per_game' | 'rebounds_per_game'
  | 'assists_per_game' | 'steals_per_game' | 'blocks_per_game' | 'turnovers_per_game'
  | 'field_goal_percentage' | 'three_point_percentage' | 'free_throw_percentage'
  | 'three_pointers_made'
>;

export interface SeasonStatColumn {
  key: SeasonStatKey;
  label: string;
  full: string;
  w: string;
  decimals: number;
}

export const SEASON_STAT_COLUMNS: SeasonStatColumn[] = [
  { key: 'games_played',           label: 'GP',  full: 'Games Played',        w: 'w-[58px]', decimals: 0 },
  { key: 'minutes_per_game',       label: 'MIN', full: 'Minutes Per Game',    w: 'w-[64px]', decimals: 1 },
  { key: 'points_per_game',        label: 'PPG', full: 'Points Per Game',     w: 'w-[64px]', decimals: 1 },
  { key: 'rebounds_per_game',      label: 'RPG', full: 'Rebounds Per Game',   w: 'w-[64px]', decimals: 1 },
  { key: 'assists_per_game',       label: 'APG', full: 'Assists Per Game',    w: 'w-[64px]', decimals: 1 },
  { key: 'steals_per_game',        label: 'SPG', full: 'Steals Per Game',     w: 'w-[64px]', decimals: 1 },
  { key: 'blocks_per_game',        label: 'BPG', full: 'Blocks Per Game',     w: 'w-[64px]', decimals: 1 },
  { key: 'turnovers_per_game',     label: 'TOV', full: 'Turnovers Per Game',  w: 'w-[64px]', decimals: 1 },
  { key: 'field_goal_percentage',  label: 'FG%', full: 'Field Goal %',        w: 'w-[64px]', decimals: 1 },
  { key: 'three_point_percentage', label: '3P%', full: '3-Point %',           w: 'w-[64px]', decimals: 1 },
  { key: 'free_throw_percentage',  label: 'FT%', full: 'Free Throw %',        w: 'w-[64px]', decimals: 1 },
  { key: 'three_pointers_made',    label: '3PM', full: '3-Pointers Made Per Game', w: 'w-[64px]', decimals: 1 },
];
