import crypto from 'crypto';
import { etIsoDate } from './dates.js';
import { americanToImpliedProb } from './oddsMath.js';

/**
 * Upcoming-game odds from the ESPN public scoreboard — the same endpoint the
 * games route uses for live scores, whose payload also carries a sportsbook
 * odds node per competition. Parsing is deliberately defensive: ESPN changes
 * the odds shape between seasons and omits it entirely until books post lines,
 * so every market is optional.
 */

// odds move, but a personal app doesn't need tick-level freshness; 10 minutes
// keeps us polite to ESPN while staying current enough to bet on.
const ODDS_CACHE_TTL = 10 * 60_000;

// a rolling 3-day window (today plus two more days). during the regular
// season a wider window would surface 30+ games at once, which is noise:
// books barely post lines that far out and the AI can't say anything useful
// about a game four days away.
const FUTURE_WINDOW_DAYS = 2;

// spread/total prices fall back to the books' standard juice when ESPN gives
// us only the line. surfaced in the response so the UI can show it honestly.
export const DEFAULT_LINE_PRICE = -110;

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
  game_date: string; // YYYY-MM-DD in ET
  tipoff: string;    // e.g. "6/10 - 8:30 PM EDT"
  provider: string;
  markets: {
    spread?: SpreadMarket;
    total?: TotalMarket;
    moneyline?: MoneylineMarket;
  };
}

// the slices of ESPN's odds node we read. observed June 2026: per-side close
// prices under pointSpread/total/moneyline; older payloads only carried the
// flat details/overUnder/spread fields, kept here as fallbacks.
interface EspnPriceNode {
  close?: { line?: string; odds?: string };
}

export interface EspnOddsNode {
  provider?: { name?: string };
  details?: string;     // "NY -2.5" | "EVEN"
  overUnder?: number;
  spread?: number;      // home-relative
  homeTeamOdds?: { moneyLine?: number };
  awayTeamOdds?: { moneyLine?: number };
  moneyline?: { home?: EspnPriceNode; away?: EspnPriceNode };
  pointSpread?: { home?: EspnPriceNode; away?: EspnPriceNode };
  total?: { over?: EspnPriceNode; under?: EspnPriceNode };
}

export interface EspnEvent {
  id: string;
  date: string;
  status: { type: { name: string; detail?: string; shortDetail?: string } };
  competitions: Array<{
    competitors: Array<{
      homeAway: 'home' | 'away';
      team: { displayName: string; abbreviation?: string };
    }>;
    odds?: EspnOddsNode[];
  }>;
}

/** "-130" | "+105" | "EVEN" → american odds int; undefined when unparseable */
function parseAmerican(odds: string | undefined): number | undefined {
  if (!odds) return undefined;
  const trimmed = odds.trim();
  if (trimmed.toUpperCase() === 'EVEN') return 100;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** "o216.5" | "u216.5" | "-2.5" → numeric line; undefined when unparseable */
function parseLine(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const n = parseFloat(line.replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parses the legacy "ABBR -6.5" details string into a home-relative line.
 * Exported for unit tests. Returns undefined when the string doesn't match
 * or names a team that isn't in this game.
 */
export function parseSpreadDetails(
  details: string | undefined,
  homeAbbrev: string,
  awayAbbrev: string
): number | undefined {
  if (!details) return undefined;
  if (details.trim().toUpperCase() === 'EVEN') return 0;
  const match = details.trim().match(/^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  const [, abbrev, lineStr] = match;
  const line = parseFloat(lineStr);
  if (abbrev === homeAbbrev) return line;
  if (abbrev === awayAbbrev) return -line;
  return undefined;
}

function parseSpreadMarket(odds: EspnOddsNode, homeAbbrev: string, awayAbbrev: string): SpreadMarket | undefined {
  // preferred: per-side close lines and prices
  const homeLine = parseLine(odds.pointSpread?.home?.close?.line);
  const homePrice = parseAmerican(odds.pointSpread?.home?.close?.odds);
  const awayPrice = parseAmerican(odds.pointSpread?.away?.close?.odds);

  // fallbacks: home-relative numeric spread, then the details string
  const line =
    homeLine ??
    (typeof odds.spread === 'number' ? odds.spread : undefined) ??
    parseSpreadDetails(odds.details, homeAbbrev, awayAbbrev);
  if (line == null) return undefined;

  const hp = homePrice ?? DEFAULT_LINE_PRICE;
  const ap = awayPrice ?? DEFAULT_LINE_PRICE;
  return {
    home_line: line,
    away_line: -line,
    home_price: hp,
    away_price: ap,
    home_implied: americanToImpliedProb(hp),
    away_implied: americanToImpliedProb(ap),
  };
}

function parseTotalMarket(odds: EspnOddsNode): TotalMarket | undefined {
  const line =
    parseLine(odds.total?.over?.close?.line) ??
    (typeof odds.overUnder === 'number' ? odds.overUnder : undefined);
  if (line == null) return undefined;

  const overPrice = parseAmerican(odds.total?.over?.close?.odds) ?? DEFAULT_LINE_PRICE;
  const underPrice = parseAmerican(odds.total?.under?.close?.odds) ?? DEFAULT_LINE_PRICE;
  return {
    line,
    over_price: overPrice,
    under_price: underPrice,
    over_implied: americanToImpliedProb(overPrice),
    under_implied: americanToImpliedProb(underPrice),
  };
}

function parseMoneylineMarket(odds: EspnOddsNode): MoneylineMarket | undefined {
  const home =
    parseAmerican(odds.moneyline?.home?.close?.odds) ?? odds.homeTeamOdds?.moneyLine;
  const away =
    parseAmerican(odds.moneyline?.away?.close?.odds) ?? odds.awayTeamOdds?.moneyLine;
  if (typeof home !== 'number' || typeof away !== 'number') return undefined;

  return {
    home,
    away,
    home_implied: americanToImpliedProb(home),
    away_implied: americanToImpliedProb(away),
  };
}

/**
 * Maps one scheduled ESPN event to a BettingGame. Exported for unit tests.
 * Games without a usable odds node come back with empty markets — the UI
 * shows "odds not yet posted" and the AI context skips them.
 */
export function parseEventOdds(event: EspnEvent): BettingGame | null {
  const competition = event.competitions[0];
  const home = competition?.competitors.find((c) => c.homeAway === 'home');
  const away = competition?.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeAbbrev = home.team.abbreviation ?? '';
  const awayAbbrev = away.team.abbreviation ?? '';

  const game: BettingGame = {
    nba_game_id: event.id,
    home_team: home.team.displayName,
    away_team: away.team.displayName,
    home_abbrev: homeAbbrev,
    away_abbrev: awayAbbrev,
    // ESPN stores dates as UTC; convert to the ET calendar date (same
    // convention as the games table).
    game_date: new Date(event.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    tipoff: event.status.type.shortDetail?.trim() || event.status.type.detail?.trim() || 'Scheduled',
    provider: '',
    markets: {},
  };

  const odds = competition?.odds?.[0];
  if (!odds) return game;

  game.provider = odds.provider?.name ?? '';
  const spread = parseSpreadMarket(odds, homeAbbrev, awayAbbrev);
  const total = parseTotalMarket(odds);
  const moneyline = parseMoneylineMarket(odds);
  if (spread) game.markets.spread = spread;
  if (total) game.markets.total = total;
  if (moneyline) game.markets.moneyline = moneyline;
  return game;
}

let oddsCache: { data: BettingGame[]; fetchedAt: number } = { data: [], fetchedAt: 0 };

/**
 * Scheduled games for the rolling window with parsed odds. In-memory cache,
 * 10-min TTL. Throws on ESPN failure — callers map that to 502/504 like
 * games.ts. Only games that have not tipped off are returned, which is also
 * what makes the AI picks cache safe: once a game goes live it drops out of
 * the snapshot, the odds hash changes, and cached picks for it expire.
 */
export async function getUpcomingOdds(): Promise<BettingGame[]> {
  if (Date.now() - oddsCache.fetchedAt < ODDS_CACHE_TTL && oddsCache.data.length > 0) {
    return oddsCache.data;
  }

  const start = etIsoDate(0).replace(/-/g, '');
  const end = etIsoDate(FUTURE_WINDOW_DAYS).replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${start}-${end}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  let resp: globalThis.Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    const err = new Error('ESPN API unavailable') as Error & { espnStatus: number };
    err.espnStatus = resp.status;
    throw err;
  }

  const data = (await resp.json()) as { events?: EspnEvent[] };
  const games = (data.events ?? [])
    .filter((e) => e.status?.type?.name === 'STATUS_SCHEDULED')
    .map(parseEventOdds)
    .filter((g): g is BettingGame => g !== null);

  // don't cache an empty window — let the next request retry immediately.
  if (games.length > 0) {
    oddsCache = { data: games, fetchedAt: Date.now() };
  }
  return games;
}

/**
 * Stable fingerprint of an odds snapshot. Part of the AI picks cache key, so
 * a line move (or a new game appearing) invalidates cached picks.
 */
export function computeOddsHash(games: BettingGame[]): string {
  const parts = games
    .map((g) => {
      const s = g.markets.spread;
      const t = g.markets.total;
      const m = g.markets.moneyline;
      return [
        g.nba_game_id,
        s ? `${s.home_line}@${s.home_price}/${s.away_price}` : '-',
        t ? `${t.line}@${t.over_price}/${t.under_price}` : '-',
        m ? `${m.home}/${m.away}` : '-',
      ].join(':');
    })
    .sort()
    .join('|');
  return crypto.createHash('md5').update(parts).digest('hex');
}
