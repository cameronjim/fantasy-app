import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ImpactInput } from '../src/services/slate.js';

export const TRAILING_GAMES = 15;

export const MIN_TRAILING_GAMES = 8;

export const TRAILING_LOOKBACK_DAYS = 45;

export const PERSONAL_PERCENTILE = 75;
export const LEAGUE_PERCENTILE = 75;

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

function selectDatabase(useDev: boolean): string {
  dotenv.config({ path: ENV_PATH });
  if (!useDev) return 'DATABASE_URL';
  const dev = process.env.DATABASE_URL_DEV;
  if (!dev) throw new Error('--dev requires DATABASE_URL_DEV in the repo-root .env');
  process.env.DATABASE_URL = dev;
  return 'DATABASE_URL_DEV';
}

export function quantile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const exact = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lo = Math.min(Math.floor(exact), sorted.length - 2);
  return sorted[lo] + (sorted[lo + 1] - sorted[lo]) * (exact - lo);
}

export function precisionAt(ordered: boolean[], k: number): { hits: number; picks: number } {
  const picks = Math.min(k, ordered.length);
  let hits = 0;
  for (let i = 0; i < picks; i += 1) if (ordered[i]) hits += 1;
  return { hits, picks };
}

interface MethodTally {
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

  const actualImpact = new Map<string, number>();
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

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) await main();
