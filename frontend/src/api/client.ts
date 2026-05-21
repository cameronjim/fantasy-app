import axios from 'axios';
import type { Player, Team, Game, RosterPlayer, ChatMessage, TeamAnalysis } from '../types';

const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const api = axios.create({ baseURL, timeout: 120000 });

// Players
export async function getPlayers(params?: { search?: string; team?: string; position?: string }): Promise<Player[]> {
  const { data } = await api.get('/players', { params });
  return data;
}

export async function getPlayer(id: number): Promise<Player> {
  const { data } = await api.get(`/players/${id}`);
  return data;
}

// Teams
export async function getTeams(): Promise<Team[]> {
  const { data } = await api.get('/teams');
  return data;
}

export async function getTeam(id: number): Promise<Team> {
  const { data } = await api.get(`/teams/${id}`);
  return data;
}

// Games
export async function getGames(): Promise<Game[]> {
  const { data } = await api.get('/games');
  return data;
}

export async function getLiveGames(): Promise<Game[]> {
  const { data } = await api.get('/games/live');
  return data;
}

// My Roster
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

// AI
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
