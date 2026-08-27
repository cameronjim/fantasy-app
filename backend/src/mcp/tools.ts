import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSlate, parsePredictionDate } from '../services/slate.js';
import {
  getWatchlist,
  matchesPosition,
  parsePositions,
  type PositionFilter,
} from '../services/watchlist.js';
import {
  getUpcomingPredictionsForPlayer,
  parseFromDate,
  type PlayerPredictionsResponse,
} from '../services/playerPredictions.js';
import { ANALYTICS_STATS, getPlayerAnalytics, getStatDistribution } from '../services/analytics.js';
import { getRankedPlayers } from '../services/fantasyScore.js';
import { resolvePlayer, type ResolvedPlayer } from './resolvePlayer.js';
import {
  formatAnalytics,
  formatPlayersList,
  formatProjections,
  formatSlate,
  formatStatLeaders,
  formatWatchlist,
} from './format.js';

const INVALID_DATE = 'date must be a calendar day formatted YYYY-MM-DD';
const INVALID_FROM = 'from must be a calendar day formatted YYYY-MM-DD';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function safeMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : 'unknown error';
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]');
}

function guarded<Args>(
  handler: (args: Args) => Promise<CallToolResult>
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(`Query failed: ${safeMessage(err)}`);
    }
  };
}

function candidateListText(raw: string, candidates: ResolvedPlayer[]): string {
  const list = candidates
    .map((c) => `${c.name} (${c.team ?? '—'}, ${c.position ?? '—'}, id ${c.id})`)
    .join('; ');
  return `Multiple players match "${raw}". Use one of: ${list}`;
}


const getSlateShape = {
  date: isoDate.optional().describe('NBA game date, YYYY-MM-DD (ET). Omit for today.'),
  players_per_game: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(5)
    .describe('How many top players to show per game (max 8).'),
};

type GetSlateArgs = { date?: string; players_per_game: number };

export const getSlateHandler = guarded(async (args: GetSlateArgs): Promise<CallToolResult> => {
  const date = parsePredictionDate(args.date);
  if (date === null) return errorResult(INVALID_DATE);
  const slate = await getSlate(date);
  return textResult(formatSlate(slate, args.players_per_game));
});


const getWatchlistShape = {
  date: isoDate.optional().describe('Window start date, YYYY-MM-DD (ET). Omit for today.'),
  days: z.number().int().min(1).max(14).default(1).describe('Window length in days.'),
  position: z
    .enum(['G', 'F', 'C', 'PG', 'SG', 'SF', 'PF'])
    .optional()
    .describe('Position filter. Omit for all.'),
  limit: z.number().int().min(1).max(20).default(10),
};

type GetWatchlistArgs = {
  date?: string;
  days: number;
  position?: PositionFilter;
  limit: number;
};

export const getWatchlistHandler = guarded(async (args: GetWatchlistArgs): Promise<CallToolResult> => {
  const date = parsePredictionDate(args.date);
  if (date === null) return errorResult(INVALID_DATE);
  const response = await getWatchlist(date, {
    days: args.days,
    position: args.position ?? null,
    limit: args.limit,
  });
  return textResult(formatWatchlist(response));
});


const getPlayerProjectionsShape = {
  player: z.string().min(1).describe('Player name (partial ok) or numeric app player id.'),
  from: isoDate.optional().describe('Only games on/after this date.'),
  limit: z.number().int().min(1).max(60).default(5).describe('Max upcoming games to show.'),
};

type GetPlayerProjectionsArgs = { player: string; from?: string; limit: number };

export const getPlayerProjectionsHandler = guarded(
  async (args: GetPlayerProjectionsArgs): Promise<CallToolResult> => {
    const resolved = await resolvePlayer(args.player);
    if (resolved.kind === 'not_found') {
      return errorResult(`No player matches "${args.player}". Try search_players.`);
    }
    if (resolved.kind === 'ambiguous') {
      return textResult(candidateListText(args.player, resolved.candidates));
    }

    const from = parseFromDate(args.from);
    if (from === false) return errorResult(INVALID_FROM);

    const player = resolved.player;
    if (player.nba_id === null) {
      return textResult(`${player.name} has no NBA id on record; no projections available.`);
    }

    const payload: Omit<PlayerPredictionsResponse, 'player_id' | 'nba_player_id'> =
      await getUpcomingPredictionsForPlayer(player.nba_id, {
        teamAbbr: player.team,
        from,
        limit: args.limit,
      });
    return textResult(formatProjections(player, payload));
  }
);


const getPlayerAnalyticsShape = {
  player: z.string().min(1).describe('Player name (partial ok) or numeric app player id.'),
};

type GetPlayerAnalyticsArgs = { player: string };

export const getPlayerAnalyticsHandler = guarded(
  async (args: GetPlayerAnalyticsArgs): Promise<CallToolResult> => {
    const resolved = await resolvePlayer(args.player);
    if (resolved.kind === 'not_found') {
      return errorResult(`No player matches "${args.player}". Try search_players.`);
    }
    if (resolved.kind === 'ambiguous') {
      return textResult(candidateListText(args.player, resolved.candidates));
    }

    const analytics = await getPlayerAnalytics(resolved.player.id);
    if (analytics === null) return errorResult('Player not found');
    return textResult(formatAnalytics(analytics));
  }
);


const searchPlayersShape = {
  query: z.string().min(1).optional().describe('Name substring, case-insensitive.'),
  team: z.string().length(3).optional().describe('Team abbreviation, e.g. DEN.'),
  position: z.enum(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']).optional(),
  limit: z.number().int().min(1).max(50).default(10),
};

type SearchPlayersArgs = {
  query?: string;
  team?: string;
  position?: 'PG' | 'SG' | 'SF' | 'PF' | 'C' | 'G' | 'F';
  limit: number;
};

export const searchPlayersHandler = guarded(async (args: SearchPlayersArgs): Promise<CallToolResult> => {
  let players = await getRankedPlayers();

  if (args.query) {
    const q = args.query.toLowerCase();
    players = players.filter((p) => p.name.toLowerCase().includes(q));
  }
  if (args.team) {
    const t = args.team.toUpperCase();
    players = players.filter((p) => p.team?.toUpperCase() === t);
  }
  if (args.position) {
    const filter = args.position as PositionFilter;
    players = players.filter((p) => matchesPosition(parsePositions(p.position), filter));
  }

  const sliced = players.slice(0, args.limit);
  return textResult(
    formatPlayersList(sliced, { query: args.query, team: args.team, position: args.position })
  );
});


const getStatLeadersShape = {
  stat: z.enum(ANALYTICS_STATS),
  limit: z.number().int().min(1).max(25).default(10),
};

type GetStatLeadersArgs = { stat: (typeof ANALYTICS_STATS)[number]; limit: number };

export const getStatLeadersHandler = guarded(async (args: GetStatLeadersArgs): Promise<CallToolResult> => {
  const dist = await getStatDistribution(args.stat);
  return textResult(formatStatLeaders(dist, args.limit));
});


export function registerAllTools(server: McpServer): void {
  server.registerTool(
    'get_slate',
    {
      title: "Tonight's slate",
      description:
        'Projected slate for an NBA date (Eastern Time): every scheduled game with its top projected players ranked by 9-category impact score, with projected points/minutes, probability of playing, deltas vs each player\'s recent form, and injury flags. Defaults to today in ET.',
      inputSchema: getSlateShape,
      annotations: { readOnlyHint: true },
    },
    getSlateHandler
  );

  server.registerTool(
    'get_watchlist',
    {
      title: 'Big-night watchlist',
      description:
        'Players projected to meaningfully beat their own recent form over the next 1-14 days: ranked by a score combining upside vs their usual production and slate relevance, with reason codes (ROLE_INCREASE, SHOT_VOLUME_SURGE, RETURNING_FROM_ABSENCE, HOT_STREAK, TEAMMATE_ABSENCE) and supporting evidence. Good for waiver/streaming decisions.',
      inputSchema: getWatchlistShape,
      annotations: { readOnlyHint: true },
    },
    getWatchlistHandler
  );

  server.registerTool(
    'get_player_projections',
    {
      title: 'Player projections',
      description:
        'Upcoming game-by-game model projections for one player: probability of playing, projected minutes, and per-stat expected values with p10/p50/p90 ranges where available. Player can be a name (e.g. "Jokic") or the app\'s numeric player id.',
      inputSchema: getPlayerProjectionsShape,
      annotations: { readOnlyHint: true },
    },
    getPlayerProjectionsHandler
  );

  server.registerTool(
    'get_player_analytics',
    {
      title: 'Player analytics',
      description:
        "One player's season per-game stats with percentile ranks vs the rotation-player pool (GP >= 15, MPG >= 12), last-10-games vs season deltas with z-scores, recent game log, injury status, and the model's next-game prediction summary.",
      inputSchema: getPlayerAnalyticsShape,
      annotations: { readOnlyHint: true },
    },
    getPlayerAnalyticsHandler
  );

  server.registerTool(
    'search_players',
    {
      title: 'Search players',
      description:
        "Search and rank players. With no filters, returns the top players by season-long fantasy score (NBA Standard scoring). Filter by name substring, team abbreviation, or position. Returns each player's app id for use with other tools.",
      inputSchema: searchPlayersShape,
      annotations: { readOnlyHint: true },
    },
    searchPlayersHandler
  );

  server.registerTool(
    'get_stat_leaders',
    {
      title: 'Stat leaders',
      description:
        'League leaders and distribution for one per-game stat among rotation players (GP >= 15, MPG >= 12): pool mean and standard deviation plus the top players by percentile. For tov, low is good and percentiles are already inverted.',
      inputSchema: getStatLeadersShape,
      annotations: { readOnlyHint: true },
    },
    getStatLeadersHandler
  );
}
