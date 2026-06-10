import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { callClaude, buildBettingContext, extractJSON } from '../services/ai.js';
import { getUserPreferences, buildBettingPromptBlock } from '../services/preferences.js';
import { getUpcomingOdds, computeOddsHash, type BettingGame } from '../services/odds.js';
import { americanToImpliedProb, combineParlay, kellyFraction, kellyStake } from '../services/oddsMath.js';
import {
  settleBet,
  betProfit,
  summarizeLedger,
  type BetMarket,
  type BetSelection,
  type BetStatus,
} from '../services/betSettlement.js';

const router = Router();

// bump when the betting system prompt changes meaningfully — entries cached
// under the old version stop colliding and get re-prompted.
const BETTING_PROMPT_VERSION = 'betting-v1';

// shorter than the waiver cache's 4 hours because lines move. an odds change
// also rotates the cache key itself, so this TTL is the slow-path bound.
const PICKS_TTL = '90 minutes';

// quarter-kelly: full kelly assumes the win-probability estimate is exact,
// which an AI estimate never is. quarter is the standard humility discount.
const KELLY_FRACTION = 0.25;

const PARLAY_EV_NOTE =
  'Parlays multiply the house edge — the combined price is usually worse value than betting the legs individually. Treat this as entertainment and keep the stake small.';

type PickCategory = 'best_value' | 'safe' | 'hail_mary';

interface RawPick {
  game_id?: string;
  category?: string;
  market?: string;
  selection?: string;
  estimated_win_prob?: number;
  rationale?: string;
  confidence?: string;
}

interface RawParlayLeg {
  game_id?: string;
  market?: string;
  selection?: string;
}

interface EnrichedPick {
  game_id: string;
  category: PickCategory;
  market: BetMarket;
  selection: BetSelection;
  matchup: string;
  game_date: string;
  tipoff: string;
  selection_label: string;
  line: number | null;
  american_odds: number;
  implied_prob: number;
  estimated_win_prob: number;
  edge: number;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  kelly?: { full: number; quarter: number; suggested_stake: number } | null;
}

/**
 * The market data a pick resolves to in the odds snapshot: the line relative
 * to the selected side (bets-table convention), the price, and a label.
 * Returns null when the snapshot doesn't carry that market.
 */
function resolveSelection(
  game: BettingGame,
  market: BetMarket,
  selection: BetSelection
): { line: number | null; odds: number; implied: number; label: string } | null {
  if (market === 'spread' && (selection === 'home' || selection === 'away')) {
    const s = game.markets.spread;
    if (!s) return null;
    const line = selection === 'home' ? s.home_line : s.away_line;
    const odds = selection === 'home' ? s.home_price : s.away_price;
    const team = selection === 'home' ? game.home_team : game.away_team;
    return {
      line,
      odds,
      implied: americanToImpliedProb(odds),
      label: `${team} ${line > 0 ? '+' : ''}${line}`,
    };
  }
  if (market === 'total' && (selection === 'over' || selection === 'under')) {
    const t = game.markets.total;
    if (!t) return null;
    const odds = selection === 'over' ? t.over_price : t.under_price;
    return {
      line: t.line,
      odds,
      implied: americanToImpliedProb(odds),
      label: `${selection === 'over' ? 'Over' : 'Under'} ${t.line}`,
    };
  }
  if (market === 'moneyline' && (selection === 'home' || selection === 'away')) {
    const m = game.markets.moneyline;
    if (!m) return null;
    const odds = selection === 'home' ? m.home : m.away;
    const team = selection === 'home' ? game.home_team : game.away_team;
    return {
      line: null,
      odds,
      implied: americanToImpliedProb(odds),
      label: `${team} ML (${odds > 0 ? '+' : ''}${odds})`,
    };
  }
  return null;
}

const CATEGORIES: PickCategory[] = ['best_value', 'safe', 'hail_mary'];
const CONFIDENCES = ['low', 'medium', 'high'];

/**
 * Validates the model's picks against the odds snapshot and re-attaches every
 * number (line, price, implied probability) from the snapshot — a hallucinated
 * line can never reach the UI. Picks naming unknown games/markets are dropped.
 */
function enrichPicks(rawPicks: RawPick[], gamesById: Map<string, BettingGame>): EnrichedPick[] {
  const picks: EnrichedPick[] = [];
  for (const raw of rawPicks) {
    const game = raw.game_id ? gamesById.get(raw.game_id) : undefined;
    if (!game) continue;
    if (!CATEGORIES.includes(raw.category as PickCategory)) continue;
    const market = raw.market as BetMarket;
    const selection = raw.selection as BetSelection;
    const resolved = resolveSelection(game, market, selection);
    if (!resolved) continue;
    if (typeof raw.estimated_win_prob !== 'number') continue;

    const estimated = Math.min(0.95, Math.max(0.05, raw.estimated_win_prob));
    picks.push({
      game_id: game.nba_game_id,
      category: raw.category as PickCategory,
      market,
      selection,
      matchup: `${game.away_team} @ ${game.home_team}`,
      game_date: game.game_date,
      tipoff: game.tipoff,
      selection_label: resolved.label,
      line: resolved.line,
      american_odds: resolved.odds,
      implied_prob: resolved.implied,
      estimated_win_prob: estimated,
      edge: estimated - resolved.implied,
      rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
      confidence: CONFIDENCES.includes(raw.confidence ?? '')
        ? (raw.confidence as 'low' | 'medium' | 'high')
        : 'low',
    });
  }
  return picks;
}

interface ParlaySuggestion {
  legs: Array<{ game_id: string; market: BetMarket; selection: BetSelection; selection_label: string; matchup: string; american_odds: number }>;
  combined_american: number;
  combined_implied_prob: number;
  rationale: string;
  ev_note: string;
}

/** Keeps only parlay legs that match surviving picks; 2-3 legs or nothing. */
function enrichParlay(
  rawLegs: RawParlayLeg[],
  rationale: string,
  picks: EnrichedPick[]
): ParlaySuggestion | null {
  const legs = rawLegs
    .map((leg) =>
      picks.find(
        (p) => p.game_id === leg.game_id && p.market === leg.market && p.selection === leg.selection
      )
    )
    .filter((p): p is EnrichedPick => p !== undefined)
    // one leg per game — same-game correlations make combined pricing wrong
    .filter((p, i, arr) => arr.findIndex((q) => q.game_id === p.game_id) === i);

  if (legs.length < 2 || legs.length > 3) return null;

  const combined = combineParlay(legs.map((l) => l.american_odds));
  return {
    legs: legs.map((l) => ({
      game_id: l.game_id,
      market: l.market,
      selection: l.selection,
      selection_label: l.selection_label,
      matchup: l.matchup,
      american_odds: l.american_odds,
    })),
    combined_american: combined.american,
    combined_implied_prob: combined.impliedProb,
    rationale,
    ev_note: PARLAY_EV_NOTE,
  };
}

/** Stake sizing is recomputed at serve time so bankroll edits skip the AI. */
function attachKelly(picks: EnrichedPick[], bankroll: number | undefined): EnrichedPick[] {
  return picks.map((pick) => {
    if (!bankroll || bankroll <= 0) return { ...pick, kelly: null };
    const full = kellyFraction(pick.estimated_win_prob, pick.american_odds);
    return {
      ...pick,
      kelly: {
        full: Math.round(full * 10000) / 10000,
        quarter: Math.round(full * KELLY_FRACTION * 10000) / 10000,
        suggested_stake: kellyStake(pick.estimated_win_prob, pick.american_odds, bankroll, KELLY_FRACTION),
      },
    };
  });
}

function sendEspnError(res: Response, err: unknown): void {
  const isAbort = err instanceof Error && err.name === 'AbortError';
  res.status(isAbort ? 504 : 502).json({
    error: isAbort ? 'ESPN timed out' : 'ESPN API unavailable',
  });
}

// odds board is public — same data ESPN shows anyone. picks/bets are personal.
router.get('/odds', async (_req: Request, res: Response): Promise<void> => {
  try {
    const games = await getUpcomingOdds();
    res.json({ games, fetched_at: new Date().toISOString() });
  } catch (err) {
    sendEspnError(res, err);
  }
});

router.get('/picks', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    let games: BettingGame[];
    try {
      games = await getUpcomingOdds();
    } catch (err) {
      sendEspnError(res, err);
      return;
    }

    // games without posted lines can't be assessed — skip them entirely, and
    // short-circuit before any AI spend when nothing is bettable.
    const bettable = games.filter((g) => Object.keys(g.markets).length > 0);
    if (bettable.length === 0) {
      res.json({ picks: [], parlay: null, summary: '', no_games: true });
      return;
    }

    const prefs = await getUserPreferences(userId);
    const prefsBlock = buildBettingPromptBlock(prefs);
    const bankroll = prefs.betting?.bankroll;

    // bankroll/unit_size are excluded from the key (they're not in the prompt
    // block) — editing them must not burn an AI call.
    const oddsHash = computeOddsHash(bettable);
    const cacheKey = crypto
      .createHash('md5')
      .update(oddsHash + '|' + prefsBlock + '|' + BETTING_PROMPT_VERSION)
      .digest('hex');

    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh) {
      const cached = await query(
        `SELECT picks, created_at FROM betting_cache
         WHERE user_id = $1 AND odds_hash = $2 AND created_at > NOW() - INTERVAL '${PICKS_TTL}'`,
        [userId, cacheKey]
      );
      if (cached.rows.length > 0) {
        const stored = cached.rows[0].picks;
        res.json({
          ...stored,
          picks: attachKelly(stored.picks ?? [], bankroll),
          cached: true,
          cached_at: cached.rows[0].created_at,
        });
        return;
      }
    }

    const context = await buildBettingContext(bettable);

    // numbers are deliberately NOT requested back from the model — the server
    // re-attaches lines/odds from the snapshot so hallucinated prices die here.
    const systemPrompt = `You are an expert NBA betting analyst. You are given upcoming games with their posted betting markets (spread, total, moneyline), each with the sportsbook's implied probability, plus team records, offensive/defensive/net ratings, and injury reports.${prefsBlock}

Your job is to estimate the TRUE win probability of selections and find value relative to the implied probability. Rules:
- Only reference the provided games, by their exact game_id. Never invent games, lines, or odds.
- Take the posted lines and odds as given; your output is your estimated win probability and reasoning.
- Be honest and calibrated: estimated_win_prob must be between 0.30 and 0.80. Real edges over 8 percentage points are rare — most lines are efficient.
- Use the injury report and ratings to justify each pick. The "rationale" field is plain text only — no markdown.
- Provide 4 to 6 picks total across these categories:
  - "best_value": the largest gaps between your estimated probability and the implied probability.
  - "safe": high estimated win probability, even if the payout is modest.
  - "hail_mary": a longshot (plus-money) with a plausible path to hitting.
- Also build one parlay of 2-3 legs chosen from your own picks, each leg from a DIFFERENT game.
- End with a 2-3 sentence plain-text summary of the slate.

Return ONLY a JSON object with this exact shape (no prose, no markdown):
{
  "picks": [
    { "game_id": "<id>", "category": "best_value" | "safe" | "hail_mary", "market": "spread" | "total" | "moneyline", "selection": "home" | "away" | "over" | "under", "estimated_win_prob": <number 0-1>, "rationale": "<plain text>", "confidence": "low" | "medium" | "high" }
  ],
  "parlay": { "legs": [ { "game_id": "<id>", "market": "...", "selection": "..." } ], "rationale": "<plain text>" },
  "summary": "<plain text>"
}

Return ONLY valid JSON.`;

    const messages = [{ role: 'user', content: `Assess these games:\n\n${context}` }];
    const reply = await callClaude(systemPrompt, messages, { maxTokens: 3072 });

    try {
      const raw = JSON.parse(extractJSON(reply)) as {
        picks?: RawPick[];
        parlay?: { legs?: RawParlayLeg[]; rationale?: string };
        summary?: string;
      };

      const picks = enrichPicks(raw.picks ?? [], new Map(bettable.map((g) => [g.nba_game_id, g])));
      const parlay = enrichParlay(raw.parlay?.legs ?? [], raw.parlay?.rationale ?? '', picks);
      const summary = typeof raw.summary === 'string' ? raw.summary : '';

      // degenerate guard: every pick failed validation — surface without caching.
      if (picks.length === 0) {
        res.json({ picks: [], parlay: null, summary, _empty: true });
        return;
      }

      // cache WITHOUT kelly so a later bankroll edit reprices stakes on read.
      await query(
        `INSERT INTO betting_cache (user_id, odds_hash, picks, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           odds_hash = EXCLUDED.odds_hash,
           picks = EXCLUDED.picks,
           created_at = NOW()`,
        [userId, cacheKey, JSON.stringify({ picks, parlay, summary })]
      );
      res.json({ picks: attachKelly(picks, bankroll), parlay, summary });
    } catch {
      res.json({ picks: [], parlay: null, summary: '', raw: reply });
    }
  } catch {
    res.status(500).json({ error: 'Failed to generate picks' });
  }
});

interface BetRow {
  id: number;
  nba_game_id: string;
  home_team: string;
  away_team: string;
  game_date: string;
  market: BetMarket;
  selection: BetSelection;
  line: number | null;
  american_odds: number;
  stake: number;
  status: BetStatus;
  created_at: string;
  settled_at: string | null;
}

router.get('/bets', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    // lazy settlement: any pending bet whose game has gone Final gets graded
    // now. no cron needed — the ledger is only stale while nobody looks at it.
    const settleable = await query(
      `SELECT b.id, b.market, b.selection, b.line::float AS line,
              g.home_score, g.away_score
       FROM bets b
       JOIN games g ON g.nba_game_id = b.nba_game_id
       WHERE b.user_id = $1 AND b.status = 'pending'
         AND g.status = 'Final'
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL`,
      [userId]
    );
    for (const row of settleable.rows) {
      const outcome = settleBet(
        { market: row.market, selection: row.selection, line: row.line },
        row.home_score,
        row.away_score
      );
      await query(
        `UPDATE bets SET status = $1, settled_at = NOW() WHERE id = $2 AND user_id = $3`,
        [outcome, row.id, userId]
      );
    }

    const result = await query(
      `SELECT id, nba_game_id, home_team, away_team, game_date, market, selection,
              line::float AS line, american_odds, stake::float AS stake,
              status, created_at, settled_at
       FROM bets
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const bets = (result.rows as BetRow[]).map((b) => ({
      ...b,
      profit: betProfit(b.status, b.stake, b.american_odds),
    }));
    res.json({ bets, summary: summarizeLedger(bets) });
  } catch {
    res.status(500).json({ error: 'Failed to load bets' });
  }
});

router.post('/bets', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const { nba_game_id, market, selection, line, american_odds, stake } = req.body ?? {};

    if (typeof nba_game_id !== 'string' || nba_game_id.length === 0 || nba_game_id.length > 20) {
      res.status(400).json({ error: 'nba_game_id is required' });
      return;
    }
    const validSelections: Record<string, string[]> = {
      spread: ['home', 'away'],
      total: ['over', 'under'],
      moneyline: ['home', 'away'],
    };
    if (!(market in validSelections) || !validSelections[market].includes(selection)) {
      res.status(400).json({ error: 'Invalid market or selection' });
      return;
    }
    if (market === 'moneyline') {
      if (line != null) {
        res.status(400).json({ error: 'Moneyline bets have no line' });
        return;
      }
    } else {
      if (typeof line !== 'number') {
        res.status(400).json({ error: 'line is required for spread and total bets' });
        return;
      }
      if (market === 'spread' && (line < -60 || line > 60)) {
        res.status(400).json({ error: 'Spread line out of range' });
        return;
      }
      if (market === 'total' && (line < 150 || line > 350)) {
        res.status(400).json({ error: 'Total line out of range' });
        return;
      }
    }
    if (!Number.isInteger(american_odds) || Math.abs(american_odds) < 100 || Math.abs(american_odds) > 10000) {
      res.status(400).json({ error: 'american_odds must be an integer like -110 or +150' });
      return;
    }
    if (typeof stake !== 'number' || stake <= 0 || stake > 100000) {
      res.status(400).json({ error: 'stake must be between 0 and 100000' });
      return;
    }

    // resolve teams/date from the odds snapshot (covers games not yet in the
    // db), falling back to the games table for older or live games.
    let homeTeam: string | undefined;
    let awayTeam: string | undefined;
    let gameDate: string | undefined;
    try {
      const games = await getUpcomingOdds();
      const game = games.find((g) => g.nba_game_id === nba_game_id);
      if (game) {
        homeTeam = game.home_team;
        awayTeam = game.away_team;
        gameDate = game.game_date;
      }
    } catch {
      // ESPN being down shouldn't block logging a bet on a known game.
    }
    if (!homeTeam) {
      const dbGame = await query(
        `SELECT home_team, away_team, game_date FROM games WHERE nba_game_id = $1`,
        [nba_game_id]
      );
      if (dbGame.rows.length > 0) {
        homeTeam = dbGame.rows[0].home_team;
        awayTeam = dbGame.rows[0].away_team;
        gameDate = dbGame.rows[0].game_date;
      }
    }
    if (!homeTeam || !awayTeam || !gameDate) {
      res.status(400).json({ error: 'Unknown game' });
      return;
    }

    const result = await query(
      `INSERT INTO bets (user_id, nba_game_id, home_team, away_team, game_date,
                         market, selection, line, american_odds, stake)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, nba_game_id, home_team, away_team, game_date, market, selection,
                 line::float AS line, american_odds, stake::float AS stake,
                 status, created_at, settled_at`,
      [userId, nba_game_id, homeTeam, awayTeam, gameDate, market, selection,
       market === 'moneyline' ? null : line, american_odds, stake]
    );
    res.status(201).json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed to save bet' });
  }
});

router.delete('/bets/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthRequest).userId;
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid bet id' });
      return;
    }
    const result = await query(
      `DELETE FROM bets WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Bet not found' });
      return;
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Failed to delete bet' });
  }
});

export { router as bettingRouter };
