import axios from 'axios';
import type {
  Player, Team, Game, RosterPlayer, ChatMessage, TeamAnalysis,
  BettingGame, BettingPicksResponse, Bet, NewBet, LedgerSummary, BetStatus,
  PlayerSeasonRow, TeamSeasonRow,
  Rating2kSummary, Rating2kDetail, Rating2kTeamType,
  PlayerAnalytics, SlateResponse, WatchlistResponse,
} from '../types';

const BASE_URL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const api = axios.create({ baseURL: BASE_URL, timeout: 120000 });

let authToken: string | null = localStorage.getItem('auth_token');

api.interceptors.request.use((config) => {
  if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
  return config;
});

export function setAuthToken(token: string | null): void {
  authToken = token;
  if (token) localStorage.setItem('auth_token', token);
  else localStorage.removeItem('auth_token');
}

export function getAuthToken(): string | null {
  return authToken;
}

export async function login(username: string, password: string): Promise<void> {
  const { data } = await api.post('/auth/login', { username, password });
  setAuthToken(data.token);
}

export async function register(username: string, email: string, password: string): Promise<void> {
  const { data } = await api.post('/auth/register', { username, email, password });
  setAuthToken(data.token);
}

export async function googleSignIn(credential: string): Promise<void> {
  const { data } = await api.post('/auth/google', { credential });
  setAuthToken(data.token);
}

/** Same backend endpoint, but using the access_token flow that supports
 *  forcing the Google account picker via prompt: 'select_account'. */
export async function googleSignInWithToken(accessToken: string): Promise<void> {
  const { data } = await api.post('/auth/google', { access_token: accessToken });
  setAuthToken(data.token);
}

/**
 * Change or set the user's password. `currentPassword` is required when the
 * user already has a password; pass `null` (or omit) when setting an initial
 * password for a google-only account.
 */
export async function changePassword(
  currentPassword: string | null,
  newPassword: string
): Promise<void> {
  const body: { newPassword: string; currentPassword?: string } = { newPassword };
  if (currentPassword) body.currentPassword = currentPassword;
  await api.patch('/auth/change-password', body);
}

export async function forgotPassword(email: string): Promise<{ message: string }> {
  const { data } = await api.post('/auth/forgot-password', { email });
  return data;
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await api.post('/auth/reset-password', { token, newPassword });
}

export interface CurrentUser {
  id: number;
  username: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  // false for google-only users who haven't set a local password yet —
  // the change-password form drops the "current password" field for them.
  has_password: boolean;
  // gates the admin nav link only; the admin api re-checks server-side.
  is_admin: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const { data } = await api.get('/auth/me');
  return data;
}

export interface ProfileUpdate {
  username?: string;
  name?: string;
  email?: string;
  phone?: string;
}

/** patch only the fields the caller provides; omitted fields stay unchanged. */
export async function updateProfile(updates: ProfileUpdate): Promise<CurrentUser> {
  const { data } = await api.patch('/auth/profile', updates);
  return data;
}

export interface BettingPreferences {
  risk_appetite?: 'conservative' | 'balanced' | 'aggressive';
  preferred_markets?: Array<'spread' | 'total' | 'moneyline' | 'parlay'>;
  extra_notes?: string;
}

export interface AIPreferences {
  risk_tolerance?: 'avoid_injured' | 'balanced' | 'high_upside';
  player_age_pref?: 'veterans' | 'balanced' | 'young_upside';
  opportunity_chase?: 'yes' | 'no';
  league_format?: 'h2h_categories' | 'h2h_points' | 'roto' | 'points';
  league_size?: number;
  punt_categories?: string[];
  priority_categories?: string[];
  roster_strategy?: 'stars_scrubs' | 'balanced' | 'streaming';
  trade_activity?: 'active' | 'occasional' | 'set_forget';
  schedule_weight?: 'matters_a_lot' | 'somewhat' | 'ignore';
  rookie_hunger?: 'love_them' | 'mixed' | 'avoid';
  playoff_focus?: 'yes' | 'no';
  bench_philosophy?: 'high_upside_stash' | 'safe_role_players' | 'streaming_slots';
  position_needs?: string[];
  extra_notes?: string;
  betting?: BettingPreferences;
}

export async function getPreferences(): Promise<AIPreferences> {
  const { data } = await api.get('/preferences');
  return data;
}

export async function updatePreferences(prefs: AIPreferences): Promise<AIPreferences> {
  const { data } = await api.patch('/preferences', prefs);
  return data;
}

export interface DataStatus {
  players_updated_at: string | null;
  teams_updated_at: string | null;
  games_updated_at: string | null;
}

export async function getDataStatus(): Promise<DataStatus> {
  const { data } = await api.get('/status');
  return data;
}

export async function getPlayers(params?: { search?: string; team?: string; position?: string }): Promise<Player[]> {
  const { data } = await api.get('/players', { params });
  return data;
}

export async function getPlayer(id: number): Promise<Player> {
  const { data } = await api.get(`/players/${id}`);
  return data;
}

/**
 * Percentiles, distributions and recent-form trends for one player. The trend
 * arrays come back empty for players with no ingested game logs, so callers
 * must render the percentile half on its own.
 */
export async function getPlayerAnalytics(id: number): Promise<PlayerAnalytics> {
  const { data } = await api.get<PlayerAnalytics>(`/players/${id}/analytics`);
  return {
    ...data,
    percentiles: data.percentiles ?? [],
    distributions: data.distributions ?? [],
    trends: {
      games: data.trends?.games ?? [],
      rolling: data.trends?.rolling ?? [],
      last10_vs_season: data.trends?.last10_vs_season ?? [],
    },
    prediction: data.prediction ?? null,
  };
}

/**
 * The day's games with each game's top projected players. `date` is a
 * YYYY-MM-DD ET calendar day; omitting it asks the server for today.
 *
 * Both `run: null` (no completed model run) and an empty `games` array are
 * normal answers, not errors — the page renders an empty state for each.
 */
export async function getSlate(date?: string): Promise<SlateResponse> {
  const { data } = await api.get<SlateResponse>('/predictions/slate', {
    params: date ? { date } : {},
  });
  return {
    date: data.date,
    run: data.run ?? null,
    games: (data.games ?? []).map((game) => ({ ...game, players: game.players ?? [] })),
  };
}

/** Ranked waiver-discovery candidates with the rule codes that flagged them. */
export async function getWatchlist(date?: string): Promise<WatchlistResponse> {
  const { data } = await api.get<WatchlistResponse>('/watchlist', {
    params: date ? { date } : {},
  });
  return {
    date: data.date,
    players: (data.players ?? []).map((player) => ({
      ...player,
      reasons: player.reasons ?? [],
      evidence: player.evidence ?? {},
    })),
  };
}

export async function getTeams(): Promise<Team[]> {
  const { data } = await api.get('/teams');
  return data;
}

export async function getTeam(id: number): Promise<Team> {
  const { data } = await api.get(`/teams/${id}`);
  return data;
}

export async function getGames(): Promise<Game[]> {
  const { data } = await api.get('/games');
  return data;
}

export async function getLiveGames(): Promise<Game[]> {
  const { data } = await api.get('/games/live');
  return data;
}

export interface HistoryPlayersParams {
  season: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryPlayersResponse {
  season: string;
  // total matching rows on the server, which can exceed the returned page.
  total: number;
  players: PlayerSeasonRow[];
}

export interface PlayerCareerResponse {
  nba_player_id: string;
  player_name: string;
  // oldest season first, so the table reads like a career timeline.
  seasons: PlayerSeasonRow[];
}

/** Seasons with ingested historical data, newest first. Empty until the
 *  one-time backfill has been run. */
export async function getHistorySeasons(): Promise<string[]> {
  const { data } = await api.get<{ seasons: string[] }>('/history/seasons');
  return data.seasons ?? [];
}

export async function getHistoryPlayers(params: HistoryPlayersParams): Promise<HistoryPlayersResponse> {
  const { data } = await api.get<HistoryPlayersResponse>('/history/players', { params });
  return { season: data.season, total: data.total ?? 0, players: data.players ?? [] };
}

export async function getPlayerCareer(nbaPlayerId: string): Promise<PlayerCareerResponse> {
  const { data } = await api.get<PlayerCareerResponse>(`/history/players/${nbaPlayerId}/seasons`);
  return { ...data, seasons: data.seasons ?? [] };
}

export async function getHistoryTeams(season: string): Promise<TeamSeasonRow[]> {
  const { data } = await api.get<{ season: string; teams: TeamSeasonRow[] }>('/history/teams', {
    params: { season },
  });
  return data.teams ?? [];
}

export type Ratings2kSort = 'overall' | 'name';

export interface Ratings2kPlayersParams {
  teamType: Rating2kTeamType;
  search?: string;
  limit?: number;
  offset?: number;
  sort?: Ratings2kSort;
}

export interface Ratings2kPlayersResponse {
  // total matching rows on the server, which can exceed the returned page.
  total: number;
  players: Rating2kSummary[];
}

export async function getRatings2kPlayers(
  params: Ratings2kPlayersParams
): Promise<Ratings2kPlayersResponse> {
  const { data } = await api.get<Ratings2kPlayersResponse>('/ratings2k/players', { params });
  return { total: data.total ?? 0, players: data.players ?? [] };
}

/** Full attribute breakdown for one rated player, or null when the slug is unknown. */
export async function getRatings2kPlayer(slug: string): Promise<Rating2kDetail | null> {
  try {
    const { data } = await api.get<Rating2kDetail>(
      `/ratings2k/players/${encodeURIComponent(slug)}`
    );
    return {
      player: data.player,
      attributes: data.attributes ?? [],
      badges: data.badges ?? [],
      rating_history: data.rating_history ?? [],
    };
  } catch (err) {
    // 404 is a normal answer here, not a failure — the caller distinguishes
    // "no such rated player" from "the lookup broke".
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Resolves one of our players to their 2K row by name. 2K publishes no NBA ids,
 * so the match is name-based and legitimately misses — null is expected, not an
 * error.
 */
export async function getRatings2kByName(name: string): Promise<Rating2kSummary | null> {
  const { data } = await api.get<{ player: Rating2kSummary | null }>('/ratings2k/by-player-name', {
    params: { name },
  });
  return data.player ?? null;
}

export async function getMyRoster(): Promise<RosterPlayer[]> {
  const { data } = await api.get('/fantasy/roster');
  return data;
}

export async function addToRoster(playerId: number): Promise<void> {
  await api.post('/fantasy/roster', { player_id: playerId });
}

export async function dropFromRoster(playerId: number): Promise<void> {
  await api.delete(`/fantasy/roster/${playerId}`);
}

export async function chatWithAI(message: string, contextType?: string, history?: ChatMessage[]): Promise<{ reply: string }> {
  const { data } = await api.post('/ai/chat', { message, context_type: contextType, history });
  return data;
}

export async function getTeamAnalysis(refresh?: boolean): Promise<TeamAnalysis> {
  const { data } = await api.get('/ai/team-analysis', { params: refresh ? { refresh: 'true' } : {} });
  return data;
}

export async function getWaiverSuggestions(refresh?: boolean): Promise<{ trade_targets: Array<{name: string; reasoning: string}>; waiver_pickups: Array<{name: string; reasoning: string}>; summary: string; cached?: boolean; cached_at?: string; empty_roster?: boolean; stale?: boolean }> {
  const { data } = await api.get('/ai/waiver-suggestions', { params: refresh ? { refresh: 'true' } : {} });
  return data;
}

export async function getBettingOdds(): Promise<{ games: BettingGame[]; fetched_at: string }> {
  const { data } = await api.get('/betting/odds');
  return data;
}

export async function getBettingPicks(refresh?: boolean): Promise<BettingPicksResponse> {
  const { data } = await api.get('/betting/picks', { params: refresh ? { refresh: 'true' } : {} });
  return data;
}

export async function getBets(): Promise<{ bets: Bet[]; summary: LedgerSummary }> {
  const { data } = await api.get('/betting/bets');
  return data;
}

export async function createBet(bet: NewBet): Promise<Bet> {
  const { data } = await api.post('/betting/bets', bet);
  return data;
}

export async function settleBetStatus(id: number, status: BetStatus): Promise<Bet> {
  const { data } = await api.patch(`/betting/bets/${id}`, { status });
  return data;
}

export async function deleteBet(id: number): Promise<void> {
  await api.delete(`/betting/bets/${id}`);
}

/**
 * Fire-and-forget pageview beacon. Failures are swallowed on purpose —
 * analytics must never affect the user experience.
 */
export function trackPageView(path: string, referrer?: string): void {
  api.post('/track/pageview', referrer ? { path, referrer } : { path }).catch(() => {});
}

export interface AdminUser {
  id: number;
  username: string;
  email: string | null;
  name: string | null;
  is_admin: boolean;
  created_at: string;
  has_password: boolean;
  has_google: boolean;
  roster_count: number;
  last_seen: string | null;
}

export interface AdminStats {
  totals: {
    total_users: number;
    new_users_7d: number;
    views_24h: number;
    views_7d: number;
    active_users_24h: number;
  };
  top_paths: Array<{ path: string; views: number }>;
}

export interface AdminPageView {
  id: number;
  path: string;
  referrer: string | null;
  user_agent: string | null;
  created_at: string;
  // null for views by logged-out visitors.
  username: string | null;
}

export async function getAdminUsers(): Promise<AdminUser[]> {
  const { data } = await api.get('/admin/users');
  return data;
}

export async function getAdminStats(): Promise<AdminStats> {
  const { data } = await api.get('/admin/stats');
  return data;
}

export async function getAdminViews(): Promise<AdminPageView[]> {
  const { data } = await api.get('/admin/views');
  return data;
}
