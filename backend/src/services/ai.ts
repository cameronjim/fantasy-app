import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { getRankedPlayers } from './fantasyScore.js';
import type { BettingGame } from './odds.js';

const client = new Anthropic();

const HAIKU = 'claude-haiku-4-5-20251001';

/** Pulls the JSON payload out of a model reply that may be fenced or chatty. */
export function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];
  return text;
}

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

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

function formatMarketLines(game: BettingGame): string[] {
  const lines: string[] = [];
  const s = game.markets.spread;
  if (s) {
    lines.push(
      `  SPREAD: home ${s.home_line > 0 ? '+' : ''}${s.home_line} (${s.home_price}, implied ${pct(s.home_implied)}) / ` +
      `away ${s.away_line > 0 ? '+' : ''}${s.away_line} (${s.away_price}, implied ${pct(s.away_implied)})`
    );
  }
  const t = game.markets.total;
  if (t) {
    lines.push(
      `  TOTAL: ${t.line} — over (${t.over_price}, implied ${pct(t.over_implied)}) / ` +
      `under (${t.under_price}, implied ${pct(t.under_implied)})`
    );
  }
  const m = game.markets.moneyline;
  if (m) {
    lines.push(
      `  MONEYLINE: home ${m.home > 0 ? '+' : ''}${m.home} (implied ${pct(m.home_implied)}) / ` +
      `away ${m.away > 0 ? '+' : ''}${m.away} (implied ${pct(m.away_implied)})`
    );
  }
  return lines;
}

/**
 * Builds the AI context for betting picks: each upcoming game's posted
 * markets with implied probabilities, both teams' records and ratings, and
 * the injury report for rotation players on the involved teams.
 */
export async function buildBettingContext(games: BettingGame[]): Promise<string> {
  const teamNames = [...new Set(games.flatMap((g) => [g.home_team, g.away_team]))];

  const teamsResult = await query(
    `SELECT name, abbreviation, wins, losses,
            offensive_rating, defensive_rating, net_rating
     FROM teams
     WHERE name = ANY($1)`,
    [teamNames]
  );
  const teamByName = new Map<string, Record<string, unknown>>(
    teamsResult.rows.map((t: Record<string, unknown>) => [t.name as string, t])
  );

  // rotation players only (15+ mpg) — a two-way player's ankle doesn't move a line.
  const injuriesResult = await query(
    `SELECT p.name, p.team, p.injury_status, p.injury_detail, p.points_per_game
     FROM players p
     JOIN teams t ON t.abbreviation = p.team
     WHERE p.injury_status IS NOT NULL
       AND p.minutes_per_game >= 15
       AND t.name = ANY($1)
     ORDER BY p.points_per_game DESC`,
    [teamNames]
  );
  const injuriesByAbbrev = new Map<string, string[]>();
  for (const row of injuriesResult.rows) {
    const list = injuriesByAbbrev.get(row.team) ?? [];
    list.push(`${row.name} (${row.points_per_game} ppg) — ${row.injury_status}${row.injury_detail ? `: ${row.injury_detail}` : ''}`);
    injuriesByAbbrev.set(row.team, list);
  }

  const teamLine = (name: string): string => {
    const t = teamByName.get(name);
    if (!t) return `  ${name}: no team stats available`;
    return `  ${name}: ${t.wins}-${t.losses}, ORtg ${t.offensive_rating}, DRtg ${t.defensive_rating}, Net ${t.net_rating}`;
  };

  const injuryLines = (name: string, abbrev: string): string[] => {
    const list = injuriesByAbbrev.get(abbrev);
    if (!list || list.length === 0) return [];
    return [`  ${name} injuries:`, ...list.map((l) => `    - ${l}`)];
  };

  const blocks = games.map((g) => {
    const lines = [
      `GAME ${g.nba_game_id}: ${g.away_team} @ ${g.home_team} (${g.game_date}, ${g.tipoff})`,
      ...formatMarketLines(g),
      teamLine(g.home_team),
      teamLine(g.away_team),
      ...injuryLines(g.home_team, g.home_abbrev),
      ...injuryLines(g.away_team, g.away_abbrev),
    ];
    return lines.join('\n');
  });

  return `UPCOMING GAMES WITH POSTED ODDS (${games.length}):\n\n${blocks.join('\n\n')}`;
}
