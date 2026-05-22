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

export async function register(username: string, password: string): Promise<void> {
  const { data } = await api.post('/auth/register', { username, password });
  setAuthToken(data.token);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.patch('/auth/change-password', { currentPassword, newPassword });
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
