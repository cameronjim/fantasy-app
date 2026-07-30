import { useState } from 'react';
import { Eye } from 'lucide-react';
import { getWatchlist } from '../api/client';
import { useCachedResource } from '../hooks/useCachedResource';
import { formatStat, toStatNumber } from '../utils/stats';
import type {
  WatchlistEvidence,
  WatchlistPlayer,
  WatchlistReason,
  WatchlistResponse,
} from '../types';

/**
 * Every badge on this page is a deterministic rule over game logs and injury
 * status — no model output, nothing learned. The label is what fired, the
 * legend says what the rule is, and the evidence row shows the numbers it
 * fired on, so any claim here is checkable against a box score.
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
    description: 'Last 5 games average at least 4 more minutes than the last 15.',
  },
  SHOT_VOLUME_SURGE: {
    label: 'Shot volume',
    badgeClass: 'badge-primary',
    description: 'Last 5 games average at least 2.5 more field goal attempts than the last 15.',
  },
  RETURNING_FROM_ABSENCE: {
    label: 'Just back',
    badgeClass: 'badge-info',
    description: 'Played after a gap of 7 or more days between appearances.',
  },
  HOT_STREAK: {
    label: 'Hot streak',
    badgeClass: 'badge-warning',
    description:
      "Last 5 games score at least 1.5 of the player's own standard deviations above their season average.",
  },
  TEAMMATE_ABSENCE: {
    label: 'Teammate out',
    badgeClass: 'badge-accent',
    description: 'A teammate averaging 28+ minutes is ruled Out.',
  },
};

const REASON_ORDER: WatchlistReason[] = [
  'ROLE_INCREASE',
  'SHOT_VOLUME_SURGE',
  'RETURNING_FROM_ABSENCE',
  'HOT_STREAK',
  'TEAMMATE_ABSENCE',
];

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

/** Human-readable lines for whichever evidence keys the server sent. */
function evidenceLines(evidence: WatchlistEvidence): string[] {
  const lines: string[] = [];

  if (evidence.min_delta !== undefined) {
    lines.push(
      `Minutes: ${formatStat(evidence.min_r5)} over the last 5 vs ${formatStat(evidence.min_r15)} over the last 15 (+${formatStat(evidence.min_delta)})`
    );
  }
  if (evidence.fga_delta !== undefined) {
    lines.push(
      `Shots: ${formatStat(evidence.fga_r5)} attempts over the last 5 vs ${formatStat(evidence.fga_r15)} over the last 15 (+${formatStat(evidence.fga_delta)})`
    );
  }
  if (evidence.gap_days !== undefined) {
    const returned = evidence.last_game_date ? `, returned ${evidence.last_game_date}` : '';
    lines.push(`Absence: ${formatStat(evidence.gap_days, 0)} days between appearances${returned}`);
  }
  if (evidence.pts_delta !== undefined) {
    lines.push(
      `Scoring: ${formatStat(evidence.pts_r5)} over the last 5 vs a ${formatStat(evidence.pts_season)} season average (sd ${formatStat(evidence.pts_stddev)})`
    );
  }
  if (evidence.teammate_out !== undefined) {
    lines.push(
      `Out: ${evidence.teammate_out} (${formatStat(evidence.teammate_out_minutes)} minutes per game)`
    );
  }

  return lines;
}

const AvailabilityBadge = ({ value }: { value: WatchlistPlayer['prob_active'] }): JSX.Element => {
  const probability = toStatNumber(value);
  if (probability === null) {
    return (
      <span
        className="badge badge-ghost badge-sm"
        title="No prediction run has scored this date yet"
      >
        no run
      </span>
    );
  }
  const tone =
    probability >= 0.85 ? 'badge-success' : probability >= 0.6 ? 'badge-warning' : 'badge-error';
  return (
    <span
      className={`badge badge-sm tabular-nums ${tone}`}
      title="Modelled chance this player appears"
    >
      {Math.round(probability * 100)}%
    </span>
  );
};

const CandidateRow = ({
  player,
  rank,
}: {
  player: WatchlistPlayer;
  rank: number;
}): JSX.Element => {
  const lines = evidenceLines(player.evidence);

  return (
    <li className="border border-base-300 rounded-box bg-base-200">
      <details className="group">
        <summary className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 cursor-pointer list-none">
          <span className="text-xs tabular-nums opacity-40 w-6 shrink-0">{rank}</span>

          <span className="min-w-0 flex-1">
            <span className="text-sm font-semibold block truncate">{player.name}</span>
            {player.team_abbr && (
              <span className="text-[11px] opacity-50 uppercase tracking-wider">
                {player.team_abbr}
              </span>
            )}
          </span>

          <span className="flex flex-wrap gap-1">
            {player.reasons.map((reason) => (
              <ReasonBadge key={reason} reason={reason} />
            ))}
          </span>

          <AvailabilityBadge value={player.prob_active} />

          <span
            className="text-sm font-bold tabular-nums w-10 text-right"
            title="Weighted reason count, scaled by availability"
          >
            {formatStat(player.score)}
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
    </div>
  </section>
);

const NO_CANDIDATES = 'Nothing on the wire today';

/**
 * Ranked waiver-discovery candidates. The list is deliberately capped and
 * deliberately excludes established scorers — a 25-point-per-game player being
 * hot is news, but it is not a waiver claim anyone can act on.
 */
export const WatchlistPage = (): JSX.Element => {
  const [date, setDate] = useState(todayInEastern);

  const { data, loading, error, reload } = useCachedResource<WatchlistResponse>(
    `watchlist:${date}`,
    () => getWatchlist(date),
    { errorMessage: 'Failed to load the watchlist' }
  );

  const hasRun = (data?.players ?? []).some((p) => toStatNumber(p.prob_active) !== null);

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="font-bold text-xl sm:text-2xl leading-tight flex items-center gap-2">
            <Eye size={20} className="opacity-60" />
            Watchlist
          </h1>
          <p className="text-sm opacity-60 mt-0.5">
            Players whose situation just changed, ranked by how much it changed.
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
          {data.players.length > 0 && !hasRun && (
            <div className="alert alert-info py-2.5 px-3">
              <span className="text-sm">
                No prediction run yet — check back after the next model run. Ranking below uses the
                rules alone, without availability.
              </span>
            </div>
          )}

          {data.players.length === 0 ? (
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-12 gap-1">
                <p className="text-sm font-semibold">{NO_CANDIDATES}</p>
                <p className="text-xs opacity-60 max-w-md">
                  No player&apos;s minutes, shot volume, availability or scoring moved enough to
                  flag. That is a normal answer on a quiet week.
                </p>
              </div>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.players.map((player, index) => (
                <CandidateRow key={player.nba_player_id} player={player} rank={index + 1} />
              ))}
            </ul>
          )}

          <Legend />
        </div>
      )}
    </div>
  );
};
