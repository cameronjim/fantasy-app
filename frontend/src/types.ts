/**
 * Postgres NUMERIC columns are serialized as strings by `pg`, so every stat
 * that comes from one can arrive as either. Coerce with `toStatNumber` before
 * doing math or formatting — never render one of these raw.
 */
export type NumericLike = number | string;

export interface Player {
  id: number;
  // permanent stats.nba.com id; absent on rows that predate the scraper.
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

/**
 * One player's per-game averages for a single historical season, from
 * `/api/history/players`. Every stat is nullable: seasons before 1996-97
 * are missing several columns entirely in the source data.
 */
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

/** One team's season totals from `/api/history/teams`. */
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
  // true when the server returned a previous analysis because the cache key
  // rotated — the client shows it and regenerates in the background.
  stale?: boolean;
  cached_at?: string;
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
  // true when these are the previous picks served instantly because lines
  // moved — the client shows them and regenerates in the background.
  stale?: boolean;
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
  // payout (excluding returned stake) if the bet hits; null without odds.
  // optional because optimistic temp rows don't have it yet.
  to_win?: number | null;
}

export interface NewBet {
  market: BetMarket;
  nba_game_id?: string;
  selection?: BetSelection;
  line?: number | null;
  american_odds: number;
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

/**
 * Which 2K roster a rated player belongs to: `curr` current NBA players,
 * `class` classic teams, `allt` all-time teams. The same person can appear
 * under more than one, which is why `slug` — not name — identifies a row.
 */
export type Rating2kTeamType = 'curr' | 'class' | 'allt';

/** A rated player as returned by the 2K list endpoints. */
export interface Rating2kSummary {
  slug: string;
  name: string;
  team: string | null;
  team_type: Rating2kTeamType;
  // 2K scale, roughly 25-99. NumericLike because the column can arrive as a
  // string depending on how it is stored.
  overall: NumericLike | null;
  // the source sends either a list or a single joined string ("PG / SG").
  positions: string[] | string | null;
  game_version: string | null;
  player_image: string | null;
}

/** Extra bio fields the detail endpoint adds on top of the summary. */
export interface Rating2kPlayer extends Rating2kSummary {
  archetype: string | null;
  build: string | null;
  height: string | null;
  weight: string | null;
  wingspan: string | null;
}

/** One of the ~35 flat attribute name/value pairs, e.g. `threePointShot`. */
export interface Rating2kAttribute {
  attribute_name: string;
  value: NumericLike | null;
}

export interface Rating2kBadge {
  badge_name: string;
  tier?: string | null;
}

/** One past game year's overall, with the change from the previous entry. */
export interface Rating2kRatingHistoryEntry {
  game_version: string;
  overall: NumericLike | null;
  delta: NumericLike | null;
}

export interface Rating2kDetail {
  player: Rating2kPlayer;
  attributes: Rating2kAttribute[];
  badges: Rating2kBadge[];
  rating_history: Rating2kRatingHistoryEntry[];
}

/**
 * The nine fantasy categories plus minutes, as keyed by `/api/players/:id/analytics`.
 * `fg_impact` / `ft_impact` are attempt-weighted excess makes rather than raw
 * percentages, so a high-volume shooter isn't tied with a 1-for-1 bench player.
 */
export type AnalyticsStat =
  | 'pts'
  | 'reb'
  | 'ast'
  | 'stl'
  | 'blk'
  | 'fg3m'
  | 'tov'
  | 'fg_impact'
  | 'ft_impact'
  | 'minutes';

export interface AnalyticsPlayer {
  id: number;
  nba_id: string | null;
  name: string;
  team: string | null;
  position: string | null;
  headshot_url: string | null;
  // not part of the documented analytics contract, but the players table
  // carries them — the header shows a badge only when they arrive.
  injury_status?: string | null;
  injury_detail?: string | null;
}

/** When each half of the payload was last computed. `logs` is null for a
 *  player with no ingested game logs. */
export interface AnalyticsAsOf {
  logs: string | null;
  distributions: string;
}

/** The comparison population the percentiles are drawn from. */
export interface AnalyticsPool {
  key: string;
  label: string;
  definition: string;
  sample_size: NumericLike;
}

/** `percentile` is always "higher is better" — the server has already
 *  reversed it for turnovers. */
export interface StatPercentile {
  stat: AnalyticsStat;
  value: NumericLike;
  percentile: NumericLike;
}

export interface DistributionBucket {
  lo: NumericLike;
  hi: NumericLike;
  count: NumericLike;
}

/** Empirical histogram for one stat across the pool, plus where this player
 *  falls in it. Buckets are counted, not modelled — there is no fitted curve. */
export interface StatDistribution {
  stat: AnalyticsStat;
  mean: NumericLike;
  stddev: NumericLike;
  buckets: DistributionBucket[];
  player_value: NumericLike;
}

/** One box score line. Every counting stat can be absent for a player whose
 *  logs haven't been ingested, which is why the containing array may be empty. */
export interface AnalyticsGameLog {
  game_date: string;
  opponent_team_abbr?: string | null;
  is_home: boolean;
  minutes: NumericLike;
  pts: NumericLike;
  reb: NumericLike;
  ast: NumericLike;
  stl: NumericLike;
  blk: NumericLike;
  tov: NumericLike;
  fgm: NumericLike;
  fga: NumericLike;
  fg3m: NumericLike;
  fg3a: NumericLike;
  ftm: NumericLike;
  fta: NumericLike;
}

/**
 * Trailing averages aligned to the same game dates as the logs. One
 * `<stat>_r5` and `<stat>_r10` key per trend stat (minutes shortens to
 * `min_`), null while the window isn't full.
 */
export interface AnalyticsRollingPoint {
  game_date: string;
  [rollingKey: string]: NumericLike | null;
}

/** Recent form against the player's own season baseline. `z` is null when the
 *  sample is too small to standardize. */
export interface Last10VsSeason {
  stat: AnalyticsStat;
  last10: NumericLike;
  season: NumericLike;
  delta: NumericLike;
  z: NumericLike | null;
}

export interface AnalyticsTrends {
  // oldest first, up to 20 games.
  games: AnalyticsGameLog[];
  rolling: AnalyticsRollingPoint[];
  last10_vs_season: Last10VsSeason[];
}

/**
 * Forward projection. The server returns `null` until the model ships, so
 * every field here is optional and the card renders whatever arrives.
 */
/** P10/P50/P90 band served for stats the model quantifies uncertainty on. */
export interface ProjectedRange {
  p10: NumericLike;
  p50: NumericLike;
  p90: NumericLike;
}

export interface PlayerPrediction {
  summary?: string | null;
  projected?: Partial<Record<AnalyticsStat, NumericLike | ProjectedRange | null>>;
  confidence?: 'low' | 'medium' | 'high' | null;
  as_of?: string | null;
  model_version?: string | null;
  game_date?: string | null;
  prob_active?: NumericLike | null;
  conditional?: boolean;
  unconditional_pts?: NumericLike | null;
}

export interface PlayerAnalytics {
  player: AnalyticsPlayer;
  as_of: AnalyticsAsOf;
  pool: AnalyticsPool;
  percentiles: StatPercentile[];
  distributions: StatDistribution[];
  trends: AnalyticsTrends;
  prediction: PlayerPrediction | null;
}

/** Which model produced the projections currently on screen. */
export interface PredictionRun {
  model_version: string;
  predicted_at: string | null;
}

/**
 * The same run, with the provenance the per-player page shows and the slate
 * does not. `forecast_cutoff_at` is the information boundary — the run could
 * not see anything at or after it — which is a different fact from when it ran.
 */
export interface PredictionRunMeta extends PredictionRun {
  id: number;
  feature_version: string | null;
  forecast_cutoff_at: string | null;
  /** e.g. "gameday (T-6h)", read out of the run's notes. Often null. */
  horizon: string | null;
}

/**
 * One stat's numbers for one predicted game. `expected`/`p10`/`p50`/`p90` are
 * all conditional — "given he plays". `unconditional` is the same estimate with
 * the chance of sitting already priced in, so it is always the smaller one.
 *
 * Every field is nullable independently: a run that emits a mean but no
 * quantiles is normal, and so is the reverse.
 */
export interface PredictionStatLine {
  expected: NumericLike | null;
  p10: NumericLike | null;
  p50: NumericLike | null;
  p90: NumericLike | null;
  unconditional: NumericLike | null;
}

/** One scheduled game the run has a prediction for. */
export interface UpcomingGamePrediction {
  nba_game_id: string;
  game_date: string;
  /** Null when the schedule row is missing, or the player's team is on neither side. */
  opponent_abbr: string | null;
  is_home: boolean | null;
  game_status: string | null;
  /**
   * P(he plays), 0-1. A MODEL PROBABILITY, never an official injury
   * designation — the badge copy has to keep saying so.
   */
  prob_active: NumericLike | null;
  /** The pre-override model probability, when the run stores one separately. */
  prob_active_model: NumericLike | null;
  /**
   * Keyed by whatever stat names the run emitted. Deliberately an open record
   * rather than a fixed union: the emission path is still growing, and a fixed
   * list would silently hide every stat added to it.
   */
  stats: Record<string, PredictionStatLine>;
}

export interface PlayerPredictionsResponse {
  player_id: number;
  nba_player_id: string | null;
  /** Null until a run has completed — the section shows its own empty state. */
  run: PredictionRunMeta | null;
  /** Every stat key present across `games`, in the order to render columns. */
  stats: string[];
  games: UpcomingGamePrediction[];
}

/**
 * The reference set the slate's impact z-scores are measured against, described
 * by the server so the page never hardcodes the definition of a number it
 * displays. Same shape as the analytics pool descriptor.
 */
export interface SlatePool {
  key: string;
  label: string;
  definition: string;
  sample_size: number;
}

/** Unconditional per-category projections, for the compact line under a name. */
export interface SlateProjectedCategories {
  reb: NumericLike | null;
  ast: NumericLike | null;
  stl: NumericLike | null;
  blk: NumericLike | null;
  tov: NumericLike | null;
  fg3m: NumericLike | null;
}

/** One projected player inside a slate game. */
export interface SlatePlayer {
  nba_player_id: string;
  name: string;
  /**
   * True when `name` is a stand-in built from the NBA player id because the
   * roster table has no row for him yet. Rendered as an id, not as a person.
   */
  name_is_placeholder: boolean;
  team_abbr: string | null;
  /** Chance the player appears at all, 0-1. Null when the run didn't model it. */
  prob_active: NumericLike | null;
  /** Unconditional expected points — availability is already priced in. */
  proj_pts: NumericLike | null;
  proj_min_p50: NumericLike | null;
  projected: SlateProjectedCategories;
  /**
   * Projected TOTAL fantasy impact: the sum of this player's z-scores across
   * the nine categories, against `SlateResponse.pool`. 0 is an average night on
   * the slate. Null when the run did not project every category for him.
   */
  impact: NumericLike | null;
  /** Among the best few impact players in this game. */
  spotlight: boolean;
  /** Among the best impact players anywhere on the slate. */
  slate_spotlight: boolean;
}

export interface SlateGame {
  nba_game_id: string;
  game_status: string | null;
  home_team_id: string | null;
  home_team_abbr: string | null;
  away_team_id: string | null;
  away_team_abbr: string | null;
  /** The best impact in this game — the server orders the cards by it. */
  top_impact: NumericLike | null;
  /** Top projected players, best impact first. Empty until a run completes. */
  players: SlatePlayer[];
}

export interface SlateResponse {
  date: string;
  /** Null until a model run has completed — the page shows its own notice. */
  run: PredictionRun | null;
  pool: SlatePool;
  games: SlateGame[];
}

/**
 * Deterministic reasons a player landed on the watchlist. Computed from game
 * logs and injury status, never from the model — each one is checkable against
 * a box score.
 */
export type WatchlistReason =
  | 'ROLE_INCREASE'
  | 'SHOT_VOLUME_SURGE'
  | 'RETURNING_FROM_ABSENCE'
  | 'HOT_STREAK'
  | 'TEAMMATE_ABSENCE';

/** The numbers behind whichever reasons fired — only those keys are present. */
export interface WatchlistEvidence {
  min_r5?: NumericLike;
  min_r15?: NumericLike;
  min_delta?: NumericLike;
  fga_r5?: NumericLike;
  fga_r15?: NumericLike;
  fga_delta?: NumericLike;
  gap_days?: NumericLike;
  last_game_date?: string;
  pts_r5?: NumericLike;
  pts_season?: NumericLike;
  pts_stddev?: NumericLike;
  pts_delta?: NumericLike;
  teammate_out?: string;
  teammate_out_minutes?: NumericLike;
}

export interface WatchlistPlayer {
  nba_player_id: string;
  name: string;
  team_abbr: string | null;
  /** Weighted reason count, scaled by availability when a run exists. */
  score: NumericLike;
  prob_active: NumericLike | null;
  reasons: WatchlistReason[];
  evidence: WatchlistEvidence;
}

export interface WatchlistResponse {
  date: string;
  players: WatchlistPlayer[];
}
