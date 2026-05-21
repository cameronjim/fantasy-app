import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';

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

export async function buildWaiverContext(userId: number): Promise<string> {
  const [rosterResult, availableResult, tradeResult] = await Promise.all([
    query(
      `SELECT p.name, p.team, p.position,
              p.points_per_game, p.rebounds_per_game, p.assists_per_game, p.steals_per_game, p.blocks_per_game,
              p.field_goal_percentage, p.free_throw_percentage, p.three_pointers_made,
              p.turnovers_per_game, p.injury_status
       FROM my_roster mr
       JOIN players p ON mr.player_id = p.id
       WHERE mr.user_id = $1
       ORDER BY p.points_per_game DESC`,
      [userId]
    ),
    query(
      `WITH fantasy_ranked AS (
         SELECT p.*,
           ROW_NUMBER() OVER (
             ORDER BY (p.points_per_game + p.rebounds_per_game * 1.2 + p.assists_per_game * 1.5 +
                       p.steals_per_game * 3 + p.blocks_per_game * 3 + p.three_pointers_made * 1.5 -
                       p.turnovers_per_game) DESC
           ) AS fantasy_rank
         FROM players p
         WHERE p.id NOT IN (SELECT player_id FROM my_roster WHERE user_id = $1)
       )
       SELECT * FROM fantasy_ranked
       WHERE fantasy_rank BETWEEN 100 AND 400
       ORDER BY RANDOM()
       LIMIT 25`,
      [userId]
    ),
    query(
      `WITH ranked AS (
         SELECT p.*, ROW_NUMBER() OVER (
           ORDER BY (p.points_per_game + p.rebounds_per_game * 1.2 + p.assists_per_game * 1.5 +
                     p.steals_per_game * 3 + p.blocks_per_game * 3 + p.three_pointers_made * 1.5 -
                     p.turnovers_per_game) DESC
         ) AS fantasy_rank
         FROM players p
         WHERE p.id NOT IN (SELECT player_id FROM my_roster WHERE user_id = $1)
       )
       SELECT * FROM ranked WHERE fantasy_rank <= 80
       ORDER BY RANDOM()
       LIMIT 20`,
      [userId]
    ),
  ]);

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

  context += `\nWAIVER CANDIDATES (rank 100+, randomly sampled):\n`;
  for (const p of availableResult.rows) context += formatPlayerLine(p) + '\n';

  context += `\nTRADE TARGETS (top 80, randomly sampled):\n`;
  for (const p of tradeResult.rows) context += formatPlayerLine(p) + '\n';

  return context;
}
