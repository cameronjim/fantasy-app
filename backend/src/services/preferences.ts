
import { query } from '../db.js';

export interface BettingPreferences {
  risk_appetite?: 'conservative' | 'balanced' | 'aggressive';
  preferred_markets?: Array<'spread' | 'total' | 'moneyline' | 'parlay'>;
  extra_notes?: string; // freeform betting context ("I like unders", etc.)
}

export interface AIPreferences {
  risk_tolerance?: 'avoid_injured' | 'balanced' | 'high_upside';
  player_age_pref?: 'veterans' | 'balanced' | 'young_upside';
  opportunity_chase?: 'yes' | 'no';
  league_format?: 'h2h_categories' | 'h2h_points' | 'roto' | 'points';
  league_size?: number; // typical: 8, 10, 12, 14 — bounded server-side
  punt_categories?: string[]; // subset of ['PTS','REB','AST','STL','BLK','FG%','FT%','3PM','TO']
  priority_categories?: string[]; // same valid set as punt_categories
  roster_strategy?: 'stars_scrubs' | 'balanced' | 'streaming';
  trade_activity?: 'active' | 'occasional' | 'set_forget';
  schedule_weight?: 'matters_a_lot' | 'somewhat' | 'ignore';
  rookie_hunger?: 'love_them' | 'mixed' | 'avoid';
  playoff_focus?: 'yes' | 'no';
  bench_philosophy?: 'high_upside_stash' | 'safe_role_players' | 'streaming_slots';
  position_needs?: string[]; // subset of ['PG','SG','SF','PF','C']
  extra_notes?: string; // freeform user notes
  betting?: BettingPreferences;
}

export const VALID_CATEGORIES = ['PTS', 'REB', 'AST', 'STL', 'BLK', 'FG%', 'FT%', '3PM', 'TO'];
export const VALID_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

function allowlisted(values: unknown[], allowed: string[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && allowed.includes(v)) seen.add(v);
  }
  return [...seen];
}
export const VALID_BET_MARKETS = ['spread', 'total', 'moneyline', 'parlay'];

export async function getUserPreferences(userId: number): Promise<AIPreferences> {
  const result = await query('SELECT ai_preferences FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) return {};
  return (result.rows[0].ai_preferences as AIPreferences) ?? {};
}

function cleanBettingPreferences(betting: BettingPreferences): BettingPreferences {
  const cleaned: BettingPreferences = {};

  if (['conservative', 'balanced', 'aggressive'].includes(betting.risk_appetite ?? '')) {
    cleaned.risk_appetite = betting.risk_appetite;
  }
  if (Array.isArray(betting.preferred_markets)) {
    cleaned.preferred_markets = betting.preferred_markets.filter((m) =>
      VALID_BET_MARKETS.includes(m)
    );
  }
  if (typeof betting.extra_notes === 'string' && betting.extra_notes.length <= 1000) {
    cleaned.extra_notes = betting.extra_notes.trim();
  }

  return cleaned;
}

export async function setUserPreferences(userId: number, prefs: AIPreferences): Promise<void> {
  const cleaned: AIPreferences = {};

  if (['avoid_injured', 'balanced', 'high_upside'].includes(prefs.risk_tolerance ?? '')) {
    cleaned.risk_tolerance = prefs.risk_tolerance;
  }
  if (['veterans', 'balanced', 'young_upside'].includes(prefs.player_age_pref ?? '')) {
    cleaned.player_age_pref = prefs.player_age_pref;
  }
  if (['yes', 'no'].includes(prefs.opportunity_chase ?? '')) {
    cleaned.opportunity_chase = prefs.opportunity_chase;
  }
  if (['h2h_categories', 'h2h_points', 'roto', 'points'].includes(prefs.league_format ?? '')) {
    cleaned.league_format = prefs.league_format;
  }
  if (typeof prefs.league_size === 'number' && prefs.league_size >= 4 && prefs.league_size <= 20) {
    cleaned.league_size = Math.round(prefs.league_size);
  }
  if (Array.isArray(prefs.punt_categories)) {
    cleaned.punt_categories = allowlisted(prefs.punt_categories, VALID_CATEGORIES);
  }
  if (Array.isArray(prefs.priority_categories)) {
    cleaned.priority_categories = allowlisted(prefs.priority_categories, VALID_CATEGORIES);
  }
  if (['stars_scrubs', 'balanced', 'streaming'].includes(prefs.roster_strategy ?? '')) {
    cleaned.roster_strategy = prefs.roster_strategy;
  }
  if (['active', 'occasional', 'set_forget'].includes(prefs.trade_activity ?? '')) {
    cleaned.trade_activity = prefs.trade_activity;
  }
  if (['matters_a_lot', 'somewhat', 'ignore'].includes(prefs.schedule_weight ?? '')) {
    cleaned.schedule_weight = prefs.schedule_weight;
  }
  if (['love_them', 'mixed', 'avoid'].includes(prefs.rookie_hunger ?? '')) {
    cleaned.rookie_hunger = prefs.rookie_hunger;
  }
  if (['yes', 'no'].includes(prefs.playoff_focus ?? '')) {
    cleaned.playoff_focus = prefs.playoff_focus;
  }
  if (['high_upside_stash', 'safe_role_players', 'streaming_slots'].includes(prefs.bench_philosophy ?? '')) {
    cleaned.bench_philosophy = prefs.bench_philosophy;
  }
  if (Array.isArray(prefs.position_needs)) {
    cleaned.position_needs = allowlisted(prefs.position_needs, VALID_POSITIONS);
  }
  if (typeof prefs.extra_notes === 'string' && prefs.extra_notes.length <= 1000) {
    cleaned.extra_notes = prefs.extra_notes.trim();
  }
  if (prefs.betting && typeof prefs.betting === 'object') {
    cleaned.betting = cleanBettingPreferences(prefs.betting);
  }

  const existing = await getUserPreferences(userId);
  const merged = { ...existing, ...cleaned };

  await query(
    'UPDATE users SET ai_preferences = $1 WHERE id = $2',
    [JSON.stringify(merged), userId]
  );
}

export function buildPreferencesPromptBlock(prefs: AIPreferences): string {
  const lines: string[] = [];

  switch (prefs.risk_tolerance) {
    case 'avoid_injured':
      lines.push('- Strongly avoid injury-prone players, even if their per-game upside is elite. Reliability over ceiling.');
      break;
    case 'high_upside':
      lines.push('- The user is willing to roster injury-prone stars for their upside. Recommend high-ceiling players freely.');
      break;
    case 'balanced':
      lines.push('- Moderate injury risk is acceptable for proportional upside.');
      break;
  }

  switch (prefs.player_age_pref) {
    case 'veterans':
      lines.push('- Prefer established veterans with consistent production over speculative young players.');
      break;
    case 'young_upside':
      lines.push('- Favor younger players with growth potential, even if current production is lower.');
      break;
  }

  if (prefs.opportunity_chase === 'yes') {
    lines.push('- Aggressively target players who stand to gain extra minutes/usage from teammate injuries. Flag these "opportunity" plays explicitly.');
  } else if (prefs.opportunity_chase === 'no') {
    lines.push('- Do not chase short-term opportunity from teammate injuries; recommend players with sustainable roles.');
  }

  if (prefs.league_format) {
    const formatMap: Record<string, string> = {
      h2h_categories: 'head-to-head categories (each week, win/lose each of the 9 categories vs. one opponent)',
      h2h_points: 'head-to-head points (each week, fantasy points total vs. one opponent)',
      roto: 'rotisserie / roto (cumulative season-long standings across all categories)',
      points: 'season-long points league',
    };
    lines.push(`- League format: ${formatMap[prefs.league_format]}. Tailor advice for this format.`);
  }

  if (typeof prefs.league_size === 'number') {
    const rostered = prefs.league_size * 13;
    lines.push(`- League has ${prefs.league_size} teams (~${rostered} players rostered). Calibrate waiver/trade recommendations to that pool size — in a deeper league, fewer impact players are available on waivers, so suggestions should skew toward realistic streamers and lower-owned breakouts. In a shallower league, more star-adjacent players will be available.`);
  }

  if (prefs.punt_categories && prefs.punt_categories.length > 0) {
    lines.push(`- The user is PUNTING these categories (ignoring them in strategy): ${prefs.punt_categories.join(', ')}. Do not recommend players solely for strength in punted categories, and be willing to take players who would otherwise be poor fits in those categories.`);
  }

  if (prefs.priority_categories && prefs.priority_categories.length > 0) {
    lines.push(`- These are the user's PRIORITY categories (must be a strength): ${prefs.priority_categories.join(', ')}. Weight recommendations heavily toward helping these.`);
  }

  switch (prefs.roster_strategy) {
    case 'stars_scrubs':
      lines.push('- Roster construction: "stars and scrubs" — concentrate value in a few elite players, fill bench with cheap/speculative pieces.');
      break;
    case 'streaming':
      lines.push('- Roster construction: aggressive streaming — the user actively swaps bench/utility spots based on the weekly schedule. Recommend high-volume role players.');
      break;
    case 'balanced':
      lines.push('- Roster construction: balanced production across the lineup; avoid recommending obvious low-floor speculative plays.');
      break;
  }

  switch (prefs.trade_activity) {
    case 'active':
      lines.push('- The user trades actively. Include speculative buy-low and sell-high targets.');
      break;
    case 'set_forget':
      lines.push('- The user prefers a set-and-forget roster. Avoid recommending trades unless the upside is significant and durable.');
      break;
  }

  switch (prefs.schedule_weight) {
    case 'matters_a_lot':
      lines.push('- Schedule matters a lot. Heavily favor players on teams with 4+ games per week and prefer those with favorable upcoming matchups.');
      break;
    case 'ignore':
      lines.push('- Ignore weekly schedule when recommending players. Talent and role first.');
      break;
  }

  switch (prefs.rookie_hunger) {
    case 'love_them':
      lines.push('- The user loves rookies and second-year breakouts. Surface them aggressively, even if production is uneven.');
      break;
    case 'avoid':
      lines.push('- Avoid recommending rookies or unproven young players. The user wants established producers.');
      break;
  }

  if (prefs.playoff_focus === 'yes') {
    lines.push('- The user is planning for fantasy playoffs. Weight recommendations toward players who will be healthy and producing during late-season weeks; consider stashing injured stars expected back for the playoff run.');
  }

  switch (prefs.bench_philosophy) {
    case 'high_upside_stash':
      lines.push('- Bench philosophy: stash high-upside speculative players (injured stars returning, late-bloomers).');
      break;
    case 'safe_role_players':
      lines.push('- Bench philosophy: stable role players who reliably contribute every night, minimal volatility.');
      break;
    case 'streaming_slots':
      lines.push('- Bench philosophy: keep slots open for daily/weekly streaming based on schedule.');
      break;
  }

  if (prefs.position_needs && prefs.position_needs.length > 0) {
    lines.push(`- The user has roster needs at these positions: ${prefs.position_needs.join(', ')}. Bias recommendations toward filling these slots.`);
  }

  if (prefs.extra_notes && prefs.extra_notes.length > 0) {
    lines.push(`- Additional notes from the user: ${prefs.extra_notes}`);
  }

  if (lines.length === 0) return '';
  return `\n\nUSER STRATEGY PREFERENCES (must follow):\n${lines.join('\n')}\n`;
}

export function buildBettingPromptBlock(prefs: AIPreferences): string {
  const betting = prefs.betting;
  if (!betting) return '';

  const lines: string[] = [];

  switch (betting.risk_appetite) {
    case 'conservative':
      lines.push('- Risk appetite: conservative. Favor Safe picks with modest, defensible edges. Keep hail-mary suggestions tame and say so when a slate offers nothing safe.');
      break;
    case 'aggressive':
      lines.push('- Risk appetite: aggressive. The user enjoys underdogs and high-variance plays. Surface bolder hail-mary and plus-money picks.');
      break;
    case 'balanced':
      lines.push('- Risk appetite: balanced. Mix safe and value plays.');
      break;
  }

  if (betting.preferred_markets && betting.preferred_markets.length > 0) {
    lines.push(`- Preferred bet types: ${betting.preferred_markets.join(', ')}. Weight picks toward these markets.`);
  }

  if (betting.extra_notes && betting.extra_notes.length > 0) {
    lines.push(`- Additional betting notes from the user: ${betting.extra_notes}`);
  }

  if (lines.length === 0) return '';
  return `\n\nUSER BETTING PREFERENCES (must follow):\n${lines.join('\n')}\n`;
}
