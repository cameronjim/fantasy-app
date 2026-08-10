/**
 * Precision@K for the Watchlist ranking, measured against what actually
 * happened.
 *
 *   npm run backtest:watchlist -- --run 1 --dev
 *
 * READ-ONLY. Every statement this script issues is a SELECT; it writes nothing,
 * anywhere, ever. `--dev` points the pool at the dev Neon branch instead of
 * whatever `DATABASE_URL` names.
 *
 * ============================== WHAT IT MEASURES ==============================
 * For a historical prediction run whose games have since been played, it asks:
 * of the K players this ranking named for a given night, how many actually had a
 * big night? And it asks the same of two baselines, on the SAME universe, so the
 * number means something:
 *
 *   random   the base rate of big nights among eligible players. Reported as the
 *            exact expectation rather than a sampled draw — the expectation of
 *            precision@K for a uniform random pick is the base rate for every K,
 *            and quoting a sampled estimate of a quantity with a closed form
 *            would add noise and subtract nothing.
 *   points   rank by projected points, descending. This is the baseline that
 *            matters: it is what the Projections tab already does, so beating it
 *            is the whole justification for the Watchlist existing as a separate
 *            page. Losing to it would mean the deviation term is noise.
 *
 * ============================ "BIG NIGHT", DEFINED ============================
 * A player-game is a big night when BOTH hold:
 *
 *   1. PERSONAL: his actual fantasy impact is at or above the 75th percentile of
 *      his own trailing window of played games. This is the "relative to his own
 *      usual" half — the thing the ranking claims to predict.
 *
 *   2. LEAGUE: his actual fantasy impact is at or above the 75th percentile of
 *      every actual line played that night. This is the absolute floor, and it is
 *      what stops "a bench player's best game of the month" from counting. Without
 *      it the metric would reward exactly the failure mode the ranking's relevance
 *      term exists to prevent, and a harness that rewards the bug cannot detect it.
 *
 * "Actual fantasy impact" is `slate.ts::impactScores` applied to REAL box-score
 * lines instead of projections: each of the nine categories z-scored against
 * every line played that night, summed, turnovers flipped. The same machinery on
 * both sides is the point — the projected and actual numbers are then the same
 * quantity, one forecast and one observed.
 *
 * Note it is scored over all nine categories even when the run only projected
 * three. Ground truth is what a big fantasy night WAS, not what this particular
 * model was equipped to see; grading against the run's own vocabulary would let a
 * narrow run look good by being narrow.
 *
 * A player who did not play has no line, and is a MISS rather than an unknown.
 * Recommending a player who sits is a bad recommendation, and letting those
 * evaporate from the denominator would flatter every method that likes doubtful
 * players — which, since availability is priced into the relevance term, is
 * precisely a bias this harness needs to be able to see.
 *
 * ================================ ELIGIBILITY ================================
 * The universe for a date is every player the run projected who (a) has a usable
 * projection baseline, so the ranking can score him at all, and (b) has at least
 * `MIN_TRAILING_GAMES` played games in his trailing window, so "his own 75th
 * percentile" is a real number. All three methods rank the SAME universe.
 *
 * ================================== CAVEAT ==================================
 * One week of one season is a harness validation, not a verdict on the ranking.
 * With ~8 slates the K=5 numbers rest on a few dozen picks; a difference of one
 * hit moves precision@5 by 2.5 points. What this script is FOR is being run again
 * on every in-season run as they accumulate, at which point the same numbers
 * start to mean something. Treat today's output as evidence the measurement
 * works, and as a floor on how badly the ranking behaves.
 * ============================================================================
 */
import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
// type-only, so it is erased before runtime and does not import `db.js` ahead of
// `selectDatabase`. Every VALUE import below is dynamic for exactly that reason.
import type { ImpactInput } from '../src/services/slate.js';

/** Games the personal comparison window covers. */
export const TRAILING_GAMES = 15;

/**
 * Below this many played games in the window, his own 75th percentile is an
 * artifact of three or four games, so the player is dropped from the evaluation
 * entirely rather than graded against a number nobody should trust.
 */
export const MIN_TRAILING_GAMES = 8;

/**
 * How far back the trailing window may reach. Bounded so a player returning from
 * a two-month absence is compared against recent form rather than against
 * October, and so the window cannot silently cross a season boundary here (the
 * PROJECTION baseline deliberately can — see `baselines.ts` — because it has to
 * work on opening night, which this harness never runs on).
 */
export const TRAILING_LOOKBACK_DAYS = 45;

/** The two halves of the big-night test. */
export const PERSONAL_PERCENTILE = 75;
export const LEAGUE_PERCENTILE = 75;

/** Cut-offs precision is reported at. */
export const DEFAULT_KS = [5, 10] as const;

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');

interface Args {
  runId: number;
  dev: boolean;
  ks: number[];
  verbose: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { runId: 1, dev: false, ks: [...DEFAULT_KS], verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dev') args.dev = true;
    else if (flag === '--verbose') args.verbose = true;
    else if (flag === '--run') {
      const value = Number(argv[(i += 1)]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--run needs a run id');
      args.runId = value;
    } else if (flag === '--k') {
      args.ks = String(argv[(i += 1)])
        .split(',')
        .map((part) => Number(part.trim()));
      if (args.ks.some((k) => !Number.isInteger(k) || k < 1)) {
        throw new Error('--k needs a comma-separated list of positive integers');
      }
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

/**
 * `db.ts` reads `process.env.DATABASE_URL` when it is first imported, and its own
 * `dotenv.config()` does not override an already-set variable. So assigning here,
 * BEFORE any dynamic import of the app, is what points the shared pool at the dev
 * branch — without a second pool, a `Queryable` parameter threaded through every
 * service, or any change to production code paths.
 */
function selectDatabase(useDev: boolean): string {
  dotenv.config({ path: ENV_PATH });
  if (!useDev) return 'DATABASE_URL';
  const dev = process.env.DATABASE_URL_DEV;
  if (!dev) throw new Error('--dev requires DATABASE_URL_DEV in the repo-root .env');
  process.env.DATABASE_URL = dev;
  return 'DATABASE_URL_DEV';
}

/**
 * Linear-interpolated percentile of a sample, `p` in 0-100. The inverse of
 * `analytics.ts::percentRank`, which answers the other direction and so cannot be
 * reused here.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const exact = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lo = Math.min(Math.floor(exact), sorted.length - 2);
  return sorted[lo] + (sorted[lo + 1] - sorted[lo]) * (exact - lo);
}

/** Hits among the first `k` of an ordered list of outcomes. */
export function precisionAt(ordered: boolean[], k: number): { hits: number; picks: number } {
  const picks = Math.min(k, ordered.length);
  let hits = 0;
  for (let i = 0; i < picks; i += 1) if (ordered[i]) hits += 1;
  return { hits, picks };
}

interface MethodTally {
  /** Keyed by K. */
  hits: Map<number, number>;
  picks: Map<number, number>;
}

function emptyTally(ks: number[]): MethodTally {
  return {
    hits: new Map(ks.map((k) => [k, 0])),
    picks: new Map(ks.map((k) => [k, 0])),
  };
}

function addTally(tally: MethodTally, ordered: boolean[], ks: number[]): void {
  for (const k of ks) {
    const { hits, picks } = precisionAt(ordered, k);
    tally.hits.set(k, (tally.hits.get(k) ?? 0) + hits);
    tally.picks.set(k, (tally.picks.get(k) ?? 0) + picks);
  }
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '   n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`.padStart(6);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = selectDatabase(args.dev);

  // dynamic, and after selectDatabase: importing db.js is what builds the pool.
  const { query, pool } = await import('../src/db.js');
  const { PROJECTED_STATS, impactScores, toIsoDay } = await import(
    '../src/services/slate.js'
  );
  const { fetchWatchlistCandidates, scoreCandidates } = await import(
    '../src/services/watchlist.js'
  );

  const runs = await query(
    `SELECT id, model_version, feature_version, status, forecast_cutoff_at, notes
     FROM prediction_runs WHERE id = $1`,
    [args.runId]
  );
  const run = runs.rows[0];
  if (!run) throw new Error(`no prediction run with id ${args.runId}`);

  const dateRows = await query(
    `SELECT DISTINCT game_date FROM player_game_predictions
     WHERE prediction_run_id = $1 ORDER BY game_date`,
    [args.runId]
  );
  const dates = dateRows.rows.map((row) => toIsoDay(row.game_date)).filter((d): d is string => !!d);
  if (dates.length === 0) throw new Error(`run ${args.runId} has no predictions`);

  console.log(`source            ${source}`);
  console.log(`run               ${run.id} (${run.model_version}, features ${run.feature_version}, ${run.status})`);
  console.log(`forecast cutoff   ${String(run.forecast_cutoff_at)}`);
  console.log(`scored dates      ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length})`);

  // ---- actual outcomes, scored the same way projections are ----
  const statColumns = PROJECTED_STATS.map((stat) => `${stat}::float AS ${stat}`).join(', ');
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const lines = await query(
    `SELECT nba_player_id, game_date, ${statColumns}
     FROM player_game_logs
     WHERE season_type = 'Regular Season'
       AND game_date >= $1::date - $3::int
       AND game_date <= $2
       AND minutes IS NOT NULL AND minutes > 0`,
    [firstDate, lastDate, TRAILING_LOOKBACK_DAYS]
  );

  const byDate = new Map<string, Array<{ id: string; input: ImpactInput }>>();
  for (const row of lines.rows) {
    const day = toIsoDay(row.game_date);
    if (!day) continue;
    const input = {} as ImpactInput;
    for (const stat of PROJECTED_STATS) {
      const value = (row as Record<string, unknown>)[stat];
      input[stat] = value === null || value === undefined ? null : Number(value);
    }
    const list = byDate.get(day) ?? [];
    list.push({ id: String(row.nba_player_id), input });
    byDate.set(day, list);
  }

  /** `player|date` -> his actual fantasy impact that night. */
  const actualImpact = new Map<string, number>();
  /** date -> the league's 75th-percentile actual impact that night. */
  const leagueBar = new Map<string, number>();
  for (const [day, entries] of byDate) {
    const scores = impactScores(entries.map((entry) => entry.input));
    const present: number[] = [];
    entries.forEach((entry, i) => {
      const score = scores[i];
      if (score === null) return;
      actualImpact.set(`${entry.id}|${day}`, score);
      present.push(score);
    });
    if (present.length > 0) leagueBar.set(day, quantile(present, LEAGUE_PERCENTILE));
  }

  /** His played dates, newest first, so a trailing window is a slice. */
  const playedDates = new Map<string, string[]>();
  for (const [key] of actualImpact) {
    const [id, day] = key.split('|');
    const list = playedDates.get(id) ?? [];
    list.push(day);
    playedDates.set(id, list);
  }
  for (const list of playedDates.values()) list.sort((a, b) => (a < b ? 1 : -1));

  const watchlist = emptyTally(args.ks);
  const points = emptyTally(args.ks);
  let universeTotal = 0;
  let bigTotal = 0;
  let rankableTotal = 0;

  for (const date of dates) {
    const bar = leagueBar.get(date);
    if (bar === undefined) {
      console.log(`  ${date}  no played lines on this date — skipped`);
      continue;
    }

    const { candidates } = await fetchWatchlistCandidates(date, args.runId);
    const scored = scoreCandidates(candidates);

    const universe = scored
      .map((entry) => {
        const id = entry.candidate.nba_player_id;
        const trailing = (playedDates.get(id) ?? [])
          .filter((day) => day < date)
          .slice(0, TRAILING_GAMES)
          .map((day) => actualImpact.get(`${id}|${day}`))
          .filter((v): v is number => v !== undefined);
        if (trailing.length < MIN_TRAILING_GAMES) return null;

        const outcome = actualImpact.get(`${id}|${date}`) ?? null;
        const personalBar = quantile(trailing, PERSONAL_PERCENTILE);
        return {
          entry,
          // no line means he did not play, which is a miss and not an unknown.
          big: outcome !== null && outcome >= personalBar && outcome >= bar,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (universe.length === 0) {
      console.log(`  ${date}  nobody eligible — skipped`);
      continue;
    }

    const bigCount = universe.filter((row) => row.big).length;
    universeTotal += universe.length;
    bigTotal += bigCount;
    rankableTotal += universe.filter((row) => (row.entry.score ?? 0) > 0).length;

    // the ranking under test. Score descending; a null or zero score means the
    // page would not have shown the row at all, so those sort last, broken by
    // absolute impact — which is what the page falls back to when it has nothing
    // relative to say.
    const byWatchlist = [...universe].sort(
      (a, b) =>
        (b.entry.score ?? -1) - (a.entry.score ?? -1) ||
        (b.entry.candidate.impact ?? -Infinity) - (a.entry.candidate.impact ?? -Infinity)
    );
    const byPoints = [...universe].sort(
      (a, b) =>
        (b.entry.candidate.proj_pts_uncond ?? -Infinity) -
        (a.entry.candidate.proj_pts_uncond ?? -Infinity)
    );

    addTally(watchlist, byWatchlist.map((row) => row.big), args.ks);
    addTally(points, byPoints.map((row) => row.big), args.ks);

    console.log(
      `  ${date}  eligible ${String(universe.length).padStart(3)}  big nights ${String(bigCount).padStart(3)}` +
        ` (${pct(bigCount, universe.length)})  scored>0 ${String(universe.filter((r) => (r.entry.score ?? 0) > 0).length).padStart(3)}` +
        `  league bar ${bar.toFixed(2)}`
    );

    if (args.verbose) {
      for (const row of byWatchlist.slice(0, 5)) {
        const c = row.entry.candidate;
        console.log(
          `        ${row.big ? 'HIT ' : 'miss'} ${c.name.padEnd(24)} score ${String(row.entry.score ?? 0).padStart(6)}` +
            ` min ${String(c.minutes.usual?.toFixed(1) ?? '-').padStart(5)} -> ${String(c.minutes.projected?.toFixed(1) ?? '-').padStart(5)}` +
            `  impact ${String(c.impact ?? '-').padStart(6)}`
        );
      }
    }
  }

  const baseRate = universeTotal === 0 ? 0 : bigTotal / universeTotal;

  console.log('');
  console.log(`eligible player-games   ${universeTotal}`);
  console.log(`big nights              ${bigTotal}  (base rate ${(baseRate * 100).toFixed(1)}%)`);
  console.log(`rows the page would show ${rankableTotal}  (score > 0)`);
  console.log('');
  console.log('precision@K, micro-averaged over the run\'s dates');
  console.log('  K   watchlist   top-proj-pts   random (base rate)');
  for (const k of args.ks) {
    const w = pct(watchlist.hits.get(k) ?? 0, watchlist.picks.get(k) ?? 0);
    const p = pct(points.hits.get(k) ?? 0, points.picks.get(k) ?? 0);
    console.log(`  ${String(k).padStart(2)}     ${w}         ${p}               ${(baseRate * 100).toFixed(1)}%`);
  }
  console.log('');
  console.log(
    'One week of one season validates the harness; it does not settle the ranking.\n' +
      'Re-run it as in-season runs accumulate — the numbers only start to mean\n' +
      'something once there are enough slates for a few hits not to move them.'
  );

  await pool.end();
}

/**
 * Only run when invoked as a script. `main` opens a database connection, so an
 * unconditional call would make importing this module for its pure helpers —
 * which `tests/unit/watchlistBacktest.test.ts` does — try to reach Neon.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) await main();
