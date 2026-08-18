import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, TrendingUp } from 'lucide-react';
import { getWatchlist } from '../api/client';
import { useCachedResource } from '../hooks/useCachedResource';
import { formatStat, toStatNumber } from '../utils/stats';
import { availabilityBadge } from '../utils/predictions';
import type {
  DeviationStat,
  UpsideDriver,
  WatchlistEvidence,
  WatchlistPlayer,
  WatchlistReason,
  WatchlistResponse,
} from '../types';

/**
 * The big-night detector. Every row answers ONE question: is tonight unusual FOR
 * HIM, and would that matter?
 *
 * So the row's headline is the pair of deltas — "22 → 31 min", "+8.4 pts vs
 * usual" — and not the score. The score is a ranking device; the deltas are the
 * claim, and they are the part a reader can check. The badges name which
 * deterministic rule fired, and the expanded evidence shows the numbers it fired
 * on.
 *
 * Tailwind only emits classes it can see as literals, so each badge class is
 * spelled out rather than built from a template string.
 */
const REASON_META: Record<
  WatchlistReason,
  { label: string; badgeClass: string; description: string }
> = {
  ROLE_INCREASE: {
    label: 'Role increase',
    badgeClass: 'badge-success',
    description: "Tonight's projected minutes are at least 4 above his recent average.",
  },
  SHOT_VOLUME_SURGE: {
    label: 'Shot volume',
    badgeClass: 'badge-primary',
    description:
      'He is projected at least 2.5 more field goal attempts than he has been averaging.',
  },
  RETURNING_FROM_ABSENCE: {
    label: 'Just back',
    badgeClass: 'badge-info',
    description:
      'He has not played in 7 to 45 days, and the run expects him available tonight. A longer gap is an offseason, not an absence.',
  },
  HOT_STREAK: {
    label: 'Hot streak',
    badgeClass: 'badge-warning',
    description:
      "His last 5 games score at least 1.5 of his own standard deviations above his recent average.",
  },
  TEAMMATE_ABSENCE: {
    label: 'Teammate out',
    badgeClass: 'badge-accent',
    description:
      'A teammate in this game who usually plays 28+ minutes is unlikely to appear, by the run’s own availability estimate.',
  },
};

const REASON_ORDER: WatchlistReason[] = [
  'ROLE_INCREASE',
  'SHOT_VOLUME_SURGE',
  'RETURNING_FROM_ABSENCE',
  'HOT_STREAK',
  'TEAMMATE_ABSENCE',
];

/** Short labels for the deviation stats, matching the Projections category line. */
const DRIVER_LABELS: Record<DeviationStat, string> = {
  minutes: 'MIN',
  pts: 'PTS',
  reb: 'REB',
  ast: 'AST',
  stl: 'STL',
  blk: 'BLK',
  fg3m: '3PM',
};

function todayInEastern(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const ReasonBadge = ({ reason }: { reason: WatchlistReason }): JSX.Element => {
  const meta = REASON_META[reason];
  // an unknown code from a newer server still renders, just without styling.
  if (!meta) return <span className="badge badge-ghost badge-sm">{reason}</span>;
  return (
    <span className={`badge badge-sm ${meta.badgeClass}`} title={meta.description}>
      {meta.label}
    </span>
  );
};

/**
 * The headline claim: where he was, where tonight projects, and the gap. Rendered
 * as an arrow rather than a signed number because the direction is the point.
 * Nothing renders when the server had no usual to compare against.
 */
const DeltaPair = ({
  player,
}: {
  player: WatchlistPlayer;
}): JSX.Element | null => {
  const usualMin = toStatNumber(player.minutes.usual);
  const projMin = toStatNumber(player.minutes.projected);
  const ptsDelta = toStatNumber(player.points.delta);

  if (usualMin === null && ptsDelta === null) return null;

  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs tabular-nums">
      {usualMin !== null && projMin !== null && (
        <span
          className="font-semibold whitespace-nowrap"
          title={`He averages ${usualMin.toFixed(1)} minutes over his recent games played; tonight's median projection is ${projMin.toFixed(1)}.`}
        >
          {usualMin.toFixed(0)} <span className="opacity-40">→</span> {projMin.toFixed(0)} min
        </span>
      )}
      {ptsDelta !== null && (
        <span
          className="opacity-70 whitespace-nowrap"
          title={`Projected ${formatStat(player.points.projected)} points against a ${formatStat(player.points.usual)} recent average.`}
        >
          {ptsDelta > 0 ? '+' : ''}
          {ptsDelta.toFixed(1)} pts vs usual
        </span>
      )}
    </span>
  );
};

/**
 * The categories actually pulling the score up. This is what keeps a row honest
 * when the two headline deltas are flat or slightly negative and the score is
 * still positive — which happens when the peripheral categories are the ones up.
 */
const Drivers = ({ drivers }: { drivers: UpsideDriver[] }): JSX.Element | null => {
  const parts = drivers
    .map((driver) => {
      const delta = toStatNumber(driver.delta);
      if (delta === null || delta <= 0) return null;
      return `${DRIVER_LABELS[driver.stat] ?? driver.stat} +${delta.toFixed(1)}`;
    })
    .filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    <span
      className="text-[11px] opacity-50 tabular-nums whitespace-nowrap"
      title="The projections furthest above his own recent averages, biggest first"
    >
      up vs usual: {parts.join(' · ')}
    </span>
  );
};

/**
 * Availability, with the same tiers and wording as a player's upcoming-games
 * table. One model estimate should not have two vocabularies depending on which
 * page it is displayed on.
 */
const AvailabilityBadge = ({ value }: { value: WatchlistPlayer['prob_active'] }): JSX.Element => {
  const badge = availabilityBadge(value);
  return (
    <span className={`badge badge-sm tabular-nums ${badge.className}`} title={badge.hint}>
      {badge.percentText ?? badge.label}
    </span>
  );
};

/** Human-readable lines for whichever evidence keys the server sent. */
function evidenceLines(player: WatchlistPlayer, evidence: WatchlistEvidence): string[] {
  const lines: string[] = [];

  const minutesDelta = toStatNumber(player.minutes.delta);
  if (minutesDelta !== null) {
    lines.push(
      `Minutes: ${formatStat(player.minutes.projected)} projected against a ${formatStat(player.minutes.usual)} average over his last ${player.baseline_games} games played (${minutesDelta > 0 ? '+' : ''}${formatStat(minutesDelta)})`
    );
  }
  if (evidence.fga_delta !== undefined) {
    lines.push(
      `Shots: ${formatStat(evidence.fga_projected)} attempts projected against ${formatStat(evidence.fga_usual)} usual (+${formatStat(evidence.fga_delta)})`
    );
  }
  if (evidence.days_since_played !== undefined) {
    const last = evidence.last_played_date ? `, last played ${evidence.last_played_date}` : '';
    lines.push(`Absence: ${formatStat(evidence.days_since_played, 0)} days without a game${last}`);
  }
  if (evidence.pts_recent_delta !== undefined) {
    lines.push(
      `Recent form: ${formatStat(evidence.pts_recent)} points over his last 5 against a ${formatStat(player.points.usual)} average (sd ${formatStat(evidence.pts_sd)})`
    );
  }
  if (evidence.teammate_out !== undefined) {
    const chance =
      evidence.teammate_out_prob_active === undefined
        ? ''
        : `, ${Math.round((toStatNumber(evidence.teammate_out_prob_active) ?? 0) * 100)}% to play`;
    lines.push(
      `Usage freed: ${evidence.teammate_out} usually plays ${formatStat(evidence.teammate_out_minutes)} minutes${chance}`
    );
  }

  const impact = toStatNumber(player.impact);
  if (impact !== null) {
    lines.push(
      `Absolute floor: ${impact > 0 ? '+' : ''}${impact.toFixed(1)} projected total impact tonight, the ${formatStat(player.impact_percentile, 0)}th percentile of the slate — the score is multiplied by that standing, so a big jump by a player who cannot produce scores nothing`
    );
  }

  return lines;
}

const CandidateRow = ({
  player,
  rank,
}: {
  player: WatchlistPlayer;
  rank: number;
}): JSX.Element => {
  const lines = evidenceLines(player, player.evidence);
  const impact = toStatNumber(player.impact);

  return (
    <li className="border border-base-300 rounded-box bg-base-200">
      <details className="group">
        <summary className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 cursor-pointer list-none">
          <span className="text-xs tabular-nums opacity-40 w-6 shrink-0">{rank}</span>

          <span className="min-w-0 flex-1 flex flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5 min-w-0">
              <span
                className={
                  'text-sm truncate ' +
                  (player.name_is_placeholder
                    ? 'font-mono text-xs italic opacity-60'
                    : 'font-semibold')
                }
                title={
                  player.name_is_placeholder
                    ? 'This player has predictions but no roster row yet, so only his NBA id is known'
                    : undefined
                }
              >
                {player.name}
              </span>
              <span className="text-[11px] opacity-50 uppercase tracking-wider shrink-0">
                {player.team_abbr ?? '—'}
                {player.opponent_team_abbr && (
                  <>
                    <span className="opacity-50 lowercase"> vs </span>
                    {player.opponent_team_abbr}
                  </>
                )}
              </span>
            </span>
            <DeltaPair player={player} />
            <Drivers drivers={player.drivers} />
          </span>

          <span className="flex flex-wrap gap-1">
            {player.reasons.map((reason) => (
              <ReasonBadge key={reason} reason={reason} />
            ))}
          </span>

          {impact !== null && (
            <span
              className="badge badge-ghost badge-sm tabular-nums"
              title="Projected total fantasy impact tonight, against the whole slate. 0 is an average night — the same number the Projections tab ranks by."
            >
              {impact > 0 ? '+' : ''}
              {impact.toFixed(1)}
            </span>
          )}

          <AvailabilityBadge value={player.prob_active} />

          <span
            className="text-sm font-bold tabular-nums w-10 text-right"
            title="How far above his own usual, times how much tonight's absolute impact matters"
          >
            {formatStat(player.score, 2)}
          </span>
        </summary>

        {lines.length > 0 && (
          <ul
            className="px-3 pb-3 pt-0 flex flex-col gap-1"
            data-testid={`evidence-${player.nba_player_id}`}
          >
            {lines.map((line) => (
              <li key={line} className="text-xs opacity-70 pl-6">
                {line}
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
};

const Legend = (): JSX.Element => (
  <section className="card bg-base-200 border border-base-300">
    <div className="card-body p-4 gap-2">
      <h2 className="font-bold text-sm">What the badges mean</h2>
      <ul className="flex flex-col gap-1.5">
        {REASON_ORDER.map((reason) => (
          <li key={reason} className="flex items-start gap-2">
            <span className="shrink-0">
              <ReasonBadge reason={reason} />
            </span>
            <span className="text-xs opacity-60">{REASON_META[reason].description}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs opacity-60 pt-1 border-t border-base-300 mt-1">
        Badges explain a row; they do not rank it. The ranking is how far tonight&apos;s projection
        sits above the player&apos;s own recent averages, multiplied by where his absolute projected
        impact stands on tonight&apos;s slate. A bench player tripling his minutes scores nothing,
        because the second term is what makes the first one worth acting on.
      </p>
    </div>
  </section>
);

const NO_CANDIDATES = 'Nobody is projected above their own usual tonight';
const NO_RUN_NOTICE =
  'No prediction run yet — this page compares tonight’s projections against each player’s own recent form, so there is nothing to rank until a run completes.';

/**
 * Players projected to have a bigger night than they usually do, ranked by how
 * much bigger times how much it would matter.
 *
 * Every empty answer is a 200 and each renders its own notice: no completed run,
 * a run with nothing for this date, and a run on which nobody clears both terms
 * are three different states, and the last one is a legitimate answer rather than
 * a failure.
 */
export const WatchlistPage = (): JSX.Element => {
  const [date, setDate] = useState(todayInEastern);

  const { data, loading, error, reload } = useCachedResource<WatchlistResponse>(
    `watchlist:${date}`,
    () => getWatchlist(date),
    { errorMessage: 'Failed to load the watchlist' }
  );

  const baseline = data?.baseline ?? null;
  const pool = data?.pool ?? null;

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="font-bold text-xl sm:text-2xl leading-tight flex items-center gap-2">
            <TrendingUp size={20} className="opacity-60" />
            Watchlist
          </h1>
          <p className="text-sm opacity-60 mt-0.5">
            Players projected to do more than they usually do — ranked against themselves, not
            against the league.
          </p>
        </div>

        <label className="form-control">
          <span className="sr-only">As-of date</span>
          <input
            type="date"
            className="input input-bordered input-sm"
            value={date}
            aria-label="As-of date"
            onChange={(e) => setDate(e.target.value || todayInEastern())}
          />
        </label>
      </header>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      ) : !data ? (
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body flex flex-col items-center py-12 gap-4">
            <p className="text-error text-sm">{error || 'Failed to load the watchlist'}</p>
            <button onClick={() => void reload()} className="btn btn-primary btn-sm">
              Try Again
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {!data.run && (
            <div className="alert alert-info py-2.5 px-3">
              <span className="text-sm">{NO_RUN_NOTICE}</span>
            </div>
          )}

          {data.players.length === 0 ? (
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-12 gap-1">
                <p className="text-sm font-semibold">{NO_CANDIDATES}</p>
                <p className="text-xs opacity-60 max-w-md">
                  {data.run
                    ? "Nobody the run projects for this date is both above his own recent form and high enough on tonight's slate to matter. That is a normal answer, and a common one on a quiet night."
                    : 'Check back after the next model run.'}{' '}
                  <Link to="/projections" className="link link-primary">
                    The projections
                  </Link>{' '}
                  still rank who is best tonight in absolute terms.
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="text-[11px] opacity-60 flex items-center gap-1.5 flex-wrap">
                <ArrowUpRight size={13} className="text-success" />
                <span>
                  Each row shows where his minutes usually sit and where tonight projects. The score
                  on the right is that gap, weighted by how much tonight&apos;s absolute impact
                  matters.
                </span>
              </p>
              <ul className="flex flex-col gap-2">
                {data.players.map((player, index) => (
                  <CandidateRow key={player.nba_player_id} player={player} rank={index + 1} />
                ))}
              </ul>
            </>
          )}

          <Legend />

          {/* both definitions come from the server, so this page never states a
              window or a pool the numbers were not actually computed against. */}
          <footer className="text-[11px] opacity-40 pt-1 flex flex-col gap-1">
            {baseline?.definition && (
              <span>
                &ldquo;Usual&rdquo; means {baseline.label}: {baseline.definition}. Game logs, not
                season averages, so the comparison only ever uses what was known before tonight.
              </span>
            )}
            {pool?.definition && (
              <span>
                Absolute impact is measured against {pool.label.toLowerCase()}: {pool.definition}
                {pool.sample_size > 0 && ` (${pool.sample_size} players)`}.
              </span>
            )}
          </footer>
        </div>
      )}
    </div>
  );
};
