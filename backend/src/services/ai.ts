import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { getRankedPlayers } from './fantasyScore.js';

const client = new Anthropic();

const HAIKU = 'claude-haiku-4-5-20251001';

export async function callClaude(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  options: { model?: string; maxTokens?: number } = {}
): Promise<string> {
  const response = await client.messages.create({
    model: options.model ?? HAIKU,
    max_tokens: options.maxTokens ?? 1024,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });
  const block = response.content[0];
  if (block.type === 'text') return block.text;
  return '';
}

type PlayerRow = Record<string, unknown>;

function formatPlayerLine(p: PlayerRow): string {
  const inj = p.injury_status ? ` [${p.injury_status}]` : '';
  return (
    `${p.name} (${p.position}/${p.team})${inj} ` +
    `PTS:${p.points_per_game} REB:${p.rebounds_per_game} AST:${p.assists_per_game} ` +
    `STL:${p.steals_per_game} BLK:${p.blocks_per_game} FG%:${p.field_goal_percentage} ` +
    `FT%:${p.free_throw_percentage} 3PM:${p.three_pointers_made} TO:${p.turnovers_per_game}`
  );
}

export async function buildTeamContext(userId: number): Promise<string> {
  const rosterResult = await query(
    `SELECT p.name, p.team, p.position,
            p.points_per_game, p.rebounds_per_game, p.assists_per_game, p.steals_per_game, p.blocks_per_game,
            p.field_goal_percentage, p.free_throw_percentage, p.three_pointers_made,
            p.turnovers_per_game, p.injury_status
     FROM my_roster mr
     JOIN players p ON mr.player_id = p.id
     WHERE mr.user_id = $1
     ORDER BY p.points_per_game DESC`,
    [userId]
  );

  if (rosterResult.rows.length === 0) return 'No players on roster.';

  const players = rosterResult.rows;
  const avg = (key: string): string => {
    const vals = players.map((p: PlayerRow) => Number(p[key]) || 0);
    return (vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toFixed(1);
  };

  let context =
    `ROSTER AVERAGES: PTS:${avg('points_per_game')} REB:${avg('rebounds_per_game')} ` +
    `AST:${avg('assists_per_game')} STL:${avg('steals_per_game')} BLK:${avg('blocks_per_game')} ` +
    `FG%:${avg('field_goal_percentage')} FT%:${avg('free_throw_percentage')} ` +
    `3PM:${avg('three_pointers_made')} TO:${avg('turnovers_per_game')}\n\n`;
  context += `MY ROSTER (${players.length}):\n`;
  for (const p of players) context += formatPlayerLine(p) + '\n';

  return context;
}

/**
 * Builds the AI context for waiver / trade suggestions.
 *
 * leagueSize is used to compute how many players are realistically rostered
 * in the user's league (size * 13 = total rostered). Trade targets come from
 * inside that pool (other managers' players); waiver candidates come from
 * outside it. Without leagueSize we default to 10 teams.
 */
export async function buildWaiverContext(userId: number, leagueSize?: number): Promise<string> {
  const ranked = await getRankedPlayers();

  // Pull the user's roster (with full stats for the prompt).
  const rosterResult = await query(
    `SELECT p.id, p.name, p.team, p.position,
            p.points_per_game, p.rebounds_per_game, p.assists_per_game, p.steals_per_game, p.blocks_per_game,
            p.field_goal_percentage, p.free_throw_percentage, p.three_pointers_made,
            p.turnovers_per_game, p.injury_status
     FROM my_roster mr
     JOIN players p ON mr.player_id = p.id
     WHERE mr.user_id = $1
     ORDER BY p.points_per_game DESC`,
    [userId]
  );

  if (rosterResult.rows.length === 0) return 'No players on roster.';

  const rosterIds = new Set<number>(rosterResult.rows.map((r: { id: number }) => r.id));
  const players = rosterResult.rows;

  // Roster size assumption — 13 is the most common 9-cat depth.
  const ROSTER_DEPTH = 13;
  const teams = leagueSize && leagueSize >= 4 ? leagueSize : 10;
  const rosteredCutoff = teams * ROSTER_DEPTH;

  // Trade targets: presumably owned by someone in the league, so they're
  // inside the top `rosteredCutoff`. Sample with some randomness so we don't
  // always recommend the same names.
  const tradeCandidates = ranked
    .filter((p) => p.fantasy_rank != null && p.fantasy_rank <= rosteredCutoff && !rosterIds.has(p.id));
  shuffleInPlace(tradeCandidates);
  const tradeTargets = tradeCandidates.slice(0, 20);

  // Waiver candidates: ranked OUTSIDE the rostered pool. We grab a ~250-deep
  // band starting just past the cutoff so the AI has realistic, available
  // names to choose from. Sorting by RANDOM gives variety.
  const waiverBandWidth = 250;
  const waiverCandidates = ranked
    .filter((p) =>
      p.fantasy_rank != null &&
      p.fantasy_rank > rosteredCutoff &&
      p.fantasy_rank <= rosteredCutoff + waiverBandWidth &&
      !rosterIds.has(p.id)
    );
  shuffleInPlace(waiverCandidates);
  const waiverPickups = waiverCandidates.slice(0, 25);

  const avg = (key: string): string => {
    const vals = players.map((p: PlayerRow) => Number(p[key]) || 0);
    return (vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toFixed(1);
  };

  let context =
    `LEAGUE: ${teams} teams (~${rosteredCutoff} players rostered)\n` +
    `ROSTER AVERAGES: PTS:${avg('points_per_game')} REB:${avg('rebounds_per_game')} ` +
    `AST:${avg('assists_per_game')} STL:${avg('steals_per_game')} BLK:${avg('blocks_per_game')} ` +
    `FG%:${avg('field_goal_percentage')} FT%:${avg('free_throw_percentage')} ` +
    `3PM:${avg('three_pointers_made')} TO:${avg('turnovers_per_game')}\n\n`;
  context += `MY ROSTER (${players.length}):\n`;
  for (const p of players) context += formatPlayerLine(p) + '\n';

  context += `\nWAIVER CANDIDATES (fantasy rank ${rosteredCutoff + 1} – ${rosteredCutoff + waiverBandWidth}, presumed unrostered in a ${teams}-team league):\n`;
  for (const p of waiverPickups) {
    context += `[#${p.fantasy_rank}] ` + formatPlayerLine(p as unknown as PlayerRow) + '\n';
  }

  context += `\nTRADE TARGETS (top ${rosteredCutoff}, presumed rostered by other managers):\n`;
  for (const p of tradeTargets) {
    context += `[#${p.fantasy_rank}] ` + formatPlayerLine(p as unknown as PlayerRow) + '\n';
  }

  return context;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
