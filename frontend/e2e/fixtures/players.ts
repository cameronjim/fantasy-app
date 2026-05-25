// minimal player fixtures used across e2e tests. keep this list small —
// every player here lands in the rendered table, so adding 100 rows slows
// every test. add a player only when a test actually needs it.
//
// the shape must match `Player` in src/types.ts, plus the optional
// `fantasy_score` / `fantasy_rank` overlay added by the players route.

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
