// minimal player fixtures used across e2e tests. keep this list small —
// every player here lands in the rendered table, so adding 100 rows slows
// every test. add a player only when a test actually needs it.
//
// the shape must match `Player` in src/types.ts, plus the optional
// `fantasy_score` / `fantasy_rank` overlay added by the players route.

import type { PlayerAnalytics } from '../../src/types';

export interface PlayerFixture {
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
  fantasy_score: number | null;
  fantasy_rank: number | null;
}

export const ALL_STAR: PlayerFixture = {
  id: 1,
  name: 'Test Allstar',
  team: 'LAL',
  position: 'PG',
  points_per_game: 28.5,
  rebounds_per_game: 7.1,
  assists_per_game: 8.2,
  steals_per_game: 1.3,
  blocks_per_game: 0.6,
  field_goal_percentage: 48.0,
  three_point_percentage: 38.0,
  free_throw_percentage: 84.0,
  three_pointers_made: 2.4,
  turnovers_per_game: 3.1,
  minutes_per_game: 35,
  games_played: 50,
  injury_status: null,
  injury_detail: null,
  fantasy_score: 51.3,
  fantasy_rank: 1,
};

export const ROLE_PLAYER: PlayerFixture = {
  id: 2,
  name: 'Test Rolepar',
  team: 'BOS',
  position: 'SF',
  points_per_game: 14.2,
  rebounds_per_game: 5.0,
  assists_per_game: 2.1,
  steals_per_game: 0.9,
  blocks_per_game: 0.4,
  field_goal_percentage: 46.5,
  three_point_percentage: 36.0,
  free_throw_percentage: 78.0,
  three_pointers_made: 1.8,
  turnovers_per_game: 1.5,
  minutes_per_game: 28,
  games_played: 48,
  injury_status: null,
  injury_detail: null,
  fantasy_score: 28.5,
  fantasy_rank: 2,
};

// A rookie below the GP/MPG threshold — fantasy_score is null and the FS
// column should render as "-".
export const UNRANKED_ROOKIE: PlayerFixture = {
  id: 3,
  name: 'Test Rookie',
  team: 'OKC',
  position: 'SG',
  points_per_game: 12.0,
  rebounds_per_game: 3.5,
  assists_per_game: 2.0,
  steals_per_game: 0.7,
  blocks_per_game: 0.2,
  field_goal_percentage: 44.0,
  three_point_percentage: 33.0,
  free_throw_percentage: 72.0,
  three_pointers_made: 1.4,
  turnovers_per_game: 1.2,
  minutes_per_game: 18,
  games_played: 5,
  injury_status: null,
  injury_detail: null,
  fantasy_score: null,
  fantasy_rank: null,
};

export const INJURED: PlayerFixture = {
  id: 4,
  name: 'Test Injured',
  team: 'MIA',
  position: 'C',
  points_per_game: 18.5,
  rebounds_per_game: 10.1,
  assists_per_game: 3.2,
  steals_per_game: 0.7,
  blocks_per_game: 1.8,
  field_goal_percentage: 55.0,
  three_point_percentage: 0.0,
  free_throw_percentage: 70.0,
  three_pointers_made: 0.1,
  turnovers_per_game: 1.8,
  minutes_per_game: 30,
  games_played: 35,
  injury_status: 'Out',
  injury_detail: 'knee',
  fantasy_score: 36.7,
  fantasy_rank: 3,
};

export const ALL_PLAYERS: PlayerFixture[] = [ALL_STAR, ROLE_PLAYER, UNRANKED_ROOKIE, INJURED];

// Analytics payload for ALL_STAR, matching `/api/players/:id/analytics`. The
// player analytics page is the only surface that reads this, so it lives here
// rather than in every spec that needs one.
export const ALL_STAR_ANALYTICS: PlayerAnalytics = {
  player: {
    id: ALL_STAR.id,
    nba_id: '2544',
    name: ALL_STAR.name,
    team: ALL_STAR.team,
    position: ALL_STAR.position,
    headshot_url: null,
  },
  as_of: { logs: '2026-02-04T12:00:00Z', distributions: '2026-02-04T13:00:00Z' },
  pool: {
    key: 'rotation',
    label: 'Rotation players',
    definition: 'GP >= 15 and MPG >= 12 this season',
    sample_size: 312,
  },
  percentiles: [
    { stat: 'pts', value: 28.5, percentile: 94 },
    { stat: 'reb', value: 7.1, percentile: 71 },
    { stat: 'tov', value: 3.1, percentile: 22 },
    { stat: 'fg_impact', value: 1.8, percentile: 81 },
    { stat: 'ft_impact', value: 0.6, percentile: 64 },
  ],
  distributions: [
    {
      stat: 'pts',
      mean: 14.2,
      stddev: 5.6,
      player_value: 28.5,
      buckets: [
        { lo: 0, hi: 10, count: 90 },
        { lo: 10, hi: 20, count: 150 },
        { lo: 20, hi: 30, count: 60 },
        { lo: 30, hi: 40, count: 12 },
      ],
    },
    {
      stat: 'reb',
      mean: 5.1,
      stddev: 2.4,
      player_value: 7.1,
      buckets: [
        { lo: 0, hi: 5, count: 140 },
        { lo: 5, hi: 10, count: 150 },
      ],
    },
  ],
  trends: {
    games: [
      {
        game_date: '2026-02-01', opponent_team_abbr: 'BOS', is_home: true,
        minutes: 35, pts: 31, reb: 8, ast: 9, stl: 2, blk: 1, tov: 3,
        fgm: 11, fga: 21, fg3m: 3, fg3a: 7, ftm: 6, fta: 7,
      },
      {
        game_date: '2026-02-03', opponent_team_abbr: 'GSW', is_home: false,
        minutes: 33, pts: 24, reb: 6, ast: 7, stl: 1, blk: 0, tov: 4,
        fgm: 9, fga: 19, fg3m: 2, fg3a: 6, ftm: 4, fta: 4,
      },
    ],
    rolling: [
      { game_date: '2026-02-01', min_r5: 34.2, pts_r5: 27.5, pts_r10: 26.9, reb_r5: 7.0, ast_r5: 8.1 },
      { game_date: '2026-02-03', min_r5: 34.0, pts_r5: 28.1, pts_r10: 27.2, reb_r5: 7.2, ast_r5: 8.3 },
    ],
    last10_vs_season: [
      { stat: 'pts', last10: 31.2, season: 28.5, delta: 2.7, z: 1.6 },
      { stat: 'blk', last10: 0.9, season: 0.6, delta: 0.3, z: null },
    ],
  },
  prediction: null,
};
