import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';

const client = new Anthropic();

export async function callClaude(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
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

export async function buildTeamContext(): Promise<string> {
  const rosterResult = await query(
    `SELECT p.name, p.team, p.position, p.ppg, p.rpg, p.apg, p.spg, p.bpg,
            p.fg_pct, p.three_pct, p.ft_pct, p.three_pm, p.tov, p.mpg, p.gp,
            p.injury_status, p.injury_detail
     FROM my_roster mr
     JOIN players p ON mr.player_id = p.id
     ORDER BY p.ppg DESC`
  );

  if (rosterResult.rows.length === 0) {
    return 'No players on roster.';
  }

  // Compute team averages
  const players = rosterResult.rows;
  const avg = (key: string) => {
    const vals = players.map((p: Record<string, unknown>) => Number(p[key]) || 0);
    return (vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toFixed(1);
  };

  let context = `My Fantasy Roster (${players.length} players)\n\n`;
  context += `TEAM AVERAGES (9-Cat):\n`;
  context += `  PTS: ${avg('ppg')} | REB: ${avg('rpg')} | AST: ${avg('apg')} | STL: ${avg('spg')} | BLK: ${avg('bpg')}\n`;
  context += `  FG%: ${avg('fg_pct')} | FT%: ${avg('ft_pct')} | 3PM: ${avg('three_pm')} | TO: ${avg('tov')}\n\n`;
  context += `PLAYERS:\n${'─'.repeat(80)}\n`;

  for (const p of players) {
    context += `${p.name} (${p.position}) - ${p.team}\n`;
    context += `  PTS: ${p.ppg} | REB: ${p.rpg} | AST: ${p.apg} | STL: ${p.spg} | BLK: ${p.bpg}\n`;
    context += `  FG%: ${p.fg_pct} | FT%: ${p.ft_pct} | 3PM: ${p.three_pm} | TO: ${p.tov} | MPG: ${p.mpg} | GP: ${p.gp}\n`;
    if (p.injury_status) {
      context += `  INJURY: ${p.injury_status} - ${p.injury_detail || 'No details'}\n`;
    }
    context += '\n';
  }

  return context;
}

export async function buildWaiverContext(): Promise<string> {
  const teamContext = await buildTeamContext();

  // Get waiver-caliber players (ranked 121+ by composite fantasy value, not on my roster)
  const availableResult = await query(
    `SELECT p.id, p.name, p.team, p.position, p.ppg, p.rpg, p.apg, p.spg, p.bpg,
            p.fg_pct, p.three_pct, p.ft_pct, p.three_pm, p.tov, p.mpg, p.gp,
            p.injury_status
     FROM players p
     WHERE p.id NOT IN (SELECT player_id FROM my_roster)
     ORDER BY (p.ppg + p.rpg * 1.2 + p.apg * 1.5 + p.spg * 3 + p.bpg * 3 + p.three_pm * 1.5 - p.tov) DESC
     OFFSET 120
     LIMIT 50`
  );

  let context = teamContext;
  context += `\nWAIVER WIRE CANDIDATES (ranked 121+ in a 10-team league, top 50):\n`;
  context += '─'.repeat(80) + '\n';

  for (const p of availableResult.rows) {
    context += `ID: ${p.id} | ${p.name} (${p.position}) - ${p.team}\n`;
    context += `  PTS: ${p.ppg} | REB: ${p.rpg} | AST: ${p.apg} | STL: ${p.spg} | BLK: ${p.bpg}\n`;
    context += `  FG%: ${p.fg_pct} | FT%: ${p.ft_pct} | 3PM: ${p.three_pm} | TO: ${p.tov} | MPG: ${p.mpg} | GP: ${p.gp}\n`;
    if (p.injury_status) context += `  INJURY: ${p.injury_status}\n`;
    context += '\n';
  }

  // Also get top 30 rostered-caliber trade targets (top 120 minus my roster)
  const tradeResult = await query(
    `WITH ranked AS (
       SELECT p.*, ROW_NUMBER() OVER (
         ORDER BY (p.ppg + p.rpg * 1.2 + p.apg * 1.5 + p.spg * 3 + p.bpg * 3 + p.three_pm * 1.5 - p.tov) DESC
       ) AS fantasy_rank
       FROM players p
       WHERE p.id NOT IN (SELECT player_id FROM my_roster)
     )
     SELECT * FROM ranked WHERE fantasy_rank <= 120
     ORDER BY fantasy_rank
     LIMIT 30`
  );

  context += `\nTRADE TARGETS (top rostered players not on your team):\n`;
  context += '─'.repeat(80) + '\n';

  for (const p of tradeResult.rows) {
    context += `Rank ${p.fantasy_rank} | ${p.name} (${p.position}) - ${p.team}\n`;
    context += `  PTS: ${p.ppg} | REB: ${p.rpg} | AST: ${p.apg} | STL: ${p.spg} | BLK: ${p.bpg}\n`;
    context += `  FG%: ${p.fg_pct} | FT%: ${p.ft_pct} | 3PM: ${p.three_pm} | TO: ${p.tov}\n`;
    context += '\n';
  }

  return context;
}
