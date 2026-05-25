import axios from 'axios';
import type { Player, Team, Game, RosterPlayer, ChatMessage, TeamAnalysis } from '../types';

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

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.patch('/auth/change-password', { currentPassword, newPassword });
}

export async function forgotPassword(email: string): Promise<{ message: string }> {
  const { data } = await api.post('/auth/forgot-password', { email });
  return data;
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await api.post('/auth/reset-password', { token, newPassword });
}

export async function setEmail(email: string): Promise<void> {
  await api.patch('/auth/set-email', { email });
}

export interface CurrentUser {
  id: number;
  username: string;
  email: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const { data } = await api.get('/auth/me');
  return data;
}

export interface AIPreferences {
  risk_tolerance?: 'avoid_injured' | 'balanced' | 'high_upside';
  player_age_pref?: 'veterans' | 'balanced' | 'young_upside';
  opportunity_chase?: 'yes' | 'no';
  league_format?: 'h2h_categories' | 'h2h_points' | 'roto' | 'points';
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

export async function getTeamAnalysis(): Promise<TeamAnalysis> {
  const { data } = await api.get('/ai/team-analysis');
  return data;
}

export async function getWaiverSuggestions(refresh?: boolean): Promise<{ trade_targets: Array<{name: string; reasoning: string}>; waiver_pickups: Array<{name: string; reasoning: string}>; summary: string; cached?: boolean; cached_at?: string }> {
  const { data } = await api.get('/ai/waiver-suggestions', { params: refresh ? { refresh: 'true' } : {} });
  return data;
}
