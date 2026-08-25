import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, CalendarDays, Flame } from 'lucide-react';
import { getSlate } from '../api/client';
import { useCachedResource } from '../hooks/useCachedResource';
import { formatTimestamp } from '../utils/analytics';
import { formatStat, toStatNumber, STAT_PLACEHOLDER } from '../utils/stats';
import type { SlateGame, SlatePlayer, SlateResponse } from '../types';

/**
 * NBA game days run on the Eastern calendar, so "today" here is ET rather
 * than the browser's timezone — otherwise a west-coast user opens the page
 * before tip-off and sees yesterday's slate.
 */
function todayInEastern(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** "Wed, Feb 4" — the heading format for a game day. */
function formatSlateDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * daisyUI semantic color for an availability percentage. Semantic classes keep
 * this readable on every theme instead of hardcoding a palette.
 */
function availabilityClass(probability: number): string {
  if (probability >= 0.85) return 'badge-success';
  if (probability >= 0.6) return 'badge-warning';
  return 'badge-error';
}

const AvailabilityBadge = ({ value }: { value: SlatePlayer['prob_active'] }): JSX.Element => {
  const probability = toStatNumber(value);
  if (probability === null) {
    return (
      <span className="badge badge-ghost badge-sm tabular-nums" title="Availability not modelled">
        {STAT_PLACEHOLDER}
      </span>
    );
  }
  return (
    <span
      className={`badge badge-sm tabular-nums ${availabilityClass(probability)}`}
      title="Modelled chance this player appears"
    >
      {Math.round(probability * 100)}%
    </span>
  );
};

/**
 * Total projected impact, as a signed z-score sum against the slate pool. 0 is
 * an average night on this slate, so the sign carries most of the meaning and
 * is always shown.
 */
const ImpactBadge = ({ player }: { player: SlatePlayer }): JSX.Element => {
  const impact = toStatNumber(player.impact);
  if (impact === null) {
    return (
      <span
        className="badge badge-ghost badge-sm tabular-nums"
        title="No impact score for this player"
      >
        {STAT_PLACEHOLDER}
      </span>
    );
  }
  // primary for a slate-wide standout, a softer outline for the rest, so the
  // two spotlight tiers read differently without leaving the daisyUI palette.
  const tone = player.slate_spotlight
    ? 'badge-primary'
    : player.spotlight
      ? 'badge-primary badge-outline'
      : 'badge-ghost';
  return (
    <span
      className={`badge badge-sm tabular-nums font-semibold ${tone}`}
      title="Projected impact tonight. 0 is an average night."
    >
      {impact > 0 ? '+' : ''}
      {impact.toFixed(1)}
    </span>
  );
};

/** The six counting categories under the name, in box-score order. */
const CATEGORY_LABELS: ReadonlyArray<[keyof SlatePlayer['projected'], string]> = [
  ['reb', 'REB'],
  ['ast', 'AST'],
  ['stl', 'STL'],
  ['blk', 'BLK'],
  ['fg3m', '3PM'],
  ['tov', 'TOV'],
];

const CategoryLine = ({ player }: { player: SlatePlayer }): JSX.Element | null => {
  const parts = CATEGORY_LABELS.filter(
    ([key]) => toStatNumber(player.projected?.[key]) !== null
  ).map(([key, label]) => `${formatStat(player.projected[key])} ${label}`);
  if (parts.length === 0) return null;
  return (
    <span className="text-[11px] opacity-50 tabular-nums">{parts.join(' · ')}</span>
  );
};

/**
 * "+6.2 min vs usual" — shown only when tonight's minutes projection departs
 * from the player's own recent average by at least the deviation the SERVER
 * calls notable (`baseline.notable_min_delta`, the same bar the Watchlist calls
 * a role increase). The threshold is never hardcoded here: a page that invented
 * its own would eventually disagree with the badge on the other page.
 *
 * Minutes only, deliberately. `min_vs_usual` compares two per-appearance
 * numbers, so it is a statement about his ROLE. `pts_vs_usual` compares an
 * unconditional projection against a per-appearance average and so also carries
 * availability, which would read as "he lost points" for a player who is merely
 * a game-time decision. It stays in the tooltip, where it can be explained.
 *
 * An absent baseline renders nothing rather than a zero: a player with too little
 * history has no usual, which is not the same as being unchanged.
 */
const VsUsualChip = ({
  player,
  threshold,
}: {
  player: SlatePlayer;
  threshold: number;
}): JSX.Element | null => {
  const delta = toStatNumber(player.min_vs_usual);
  const usual = toStatNumber(player.usual_min);
  if (delta === null || usual === null || threshold <= 0) return null;
  if (Math.abs(delta) < threshold) return null;

  const up = delta > 0;
  const ptsDelta = toStatNumber(player.pts_vs_usual);
  const ptsPart =
    ptsDelta === null
      ? ''
      : ` Points ${ptsDelta > 0 ? '+' : ''}${ptsDelta.toFixed(1)} vs usual.`;

  return (
    <span
      className={
        'badge badge-xs tabular-nums gap-0.5 ' +
        (up ? 'badge-success badge-outline' : 'badge-warning badge-outline')
      }
      title={`Usually ${usual.toFixed(1)} min, tonight ${formatStat(player.proj_min_p50)}.${ptsPart}`}
    >
      {up ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
      {up ? '+' : ''}
      {delta.toFixed(1)} min vs usual
    </span>
  );
};

/**
 * daisyUI tone for a normalized injury bucket. Null is the "cleared" case —
 * a designation the run priced in that has since come off the report, which
 * is good news and reads as such.
 */
function injuryTone(bucket: string | null): string {
  switch (bucket) {
    case 'out':
    case 'doubtful':
      return 'badge-error';
    case 'probable':
    case 'available':
    case null:
      return 'badge-success badge-outline';
    default:
      // questionable, day_to_day, unknown — a real question mark, not a verdict.
      return 'badge-warning';
  }
}

/**
 * The CURRENT injury-report designation, which can be newer than the
 * projection. The projection already prices in availability as of when it was
 * published; this chip is what the report says NOW. The "· new" marker means
 * the designation moved after publication — a late OUT, an upgrade, or a
 * clearance — and the projected numbers do not reflect it.
 *
 * Rendered from the server's normalized bucket and raw wording; nothing is
 * inferred here. Absent fields (an older server) render nothing.
 */
const InjuryChip = ({ player }: { player: SlatePlayer }): JSX.Element | null => {
  const status = player.injury_status ?? null;
  const changed = player.injury_changed_after_run === true;
  if (status === null && !changed) return null;

  const label = status === null ? 'Cleared' : (player.injury_status_raw ?? status);
  const asOf = formatTimestamp(player.injury_as_of ?? null);
  const detailPart = player.injury_detail ? ` (${player.injury_detail})` : '';
  const title =
    status === null
      ? 'Was on the injury report when this projection was published and has since cleared. The projection does not reflect it.'
      : `Current injury report: ${label}${detailPart}${asOf ? `, as of ${asOf}` : ''}.` +
        (changed
          ? ' Reported after this projection was published, so the numbers do not reflect it.'
          : '');

  return (
    <span
      className={`badge badge-xs uppercase tracking-wide ${injuryTone(status)}`}
      title={title}
      data-testid="injury-chip"
    >
      {label}
      {changed && <span className="font-bold normal-case">&nbsp;· new</span>}
    </span>
  );
};

const PlayerRow = ({
  player,
  notableMinDelta,
}: {
  player: SlatePlayer;
  notableMinDelta: number;
}): JSX.Element => (
  <li
    className={
      'flex flex-col gap-0.5 py-1.5 px-2 -mx-2 rounded-md ' +
      (player.slate_spotlight
        ? 'bg-primary/10 ring-1 ring-primary/30'
        : player.spotlight
          ? 'bg-base-300/50'
          : '')
    }
  >
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex items-center gap-1.5">
        {player.slate_spotlight && (
          <Flame
            size={13}
            className="text-primary shrink-0"
            aria-label="Top projected impact on the slate"
          />
        )}
        <span
          className={
            'text-sm truncate ' +
            (player.name_is_placeholder ? 'font-mono text-xs italic opacity-60' : 'font-medium')
          }
          title={
            player.name_is_placeholder
              ? 'Not on a roster yet, so this is his NBA id'
              : undefined
          }
        >
          {player.name}
        </span>
        {player.team_abbr && (
          <span className="text-[11px] opacity-50 uppercase tracking-wider shrink-0">
            {player.team_abbr}
          </span>
        )}
      </span>

      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        <ImpactBadge player={player} />
        <AvailabilityBadge value={player.prob_active} />
      </span>
    </div>

    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-xs tabular-nums opacity-70 whitespace-nowrap">
        <span className="font-semibold opacity-100">{formatStat(player.proj_pts)}</span> pts
        <span className="opacity-40"> · </span>
        {formatStat(player.proj_min_p50)} min
      </span>
      <CategoryLine player={player} />
      <InjuryChip player={player} />
      <VsUsualChip player={player} threshold={notableMinDelta} />
    </div>
  </li>
);

const GameCard = ({
  game,
  notableMinDelta,
}: {
  game: SlateGame;
  notableMinDelta: number;
}): JSX.Element => (
  <section className="card bg-base-200 border border-base-300">
    <div className="card-body p-4 sm:p-5 gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-bold text-base tracking-tight">
          {game.away_team_abbr ?? 'TBD'} <span className="opacity-40 font-normal">@</span>{' '}
          {game.home_team_abbr ?? 'TBD'}
        </h2>
        {game.game_status && (
          <span className="badge badge-ghost badge-sm shrink-0">{game.game_status}</span>
        )}
      </div>

      {game.players.length === 0 ? (
        <p className="text-xs opacity-50 py-2">No projected players for this game yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {game.players.map((player) => (
            <PlayerRow
              key={player.nba_player_id}
              player={player}
              notableMinDelta={notableMinDelta}
            />
          ))}
        </ul>
      )}
    </div>
  </section>
);

const NO_RUN_NOTICE = 'No prediction run yet. Check back after the next model run.';

/**
 * The day's games with each game's top projected players. Every part of the
 * payload is optional in practice: the schedule can be empty (no games), the
 * run can be absent (model hasn't run), and a scheduled game can have no
 * projected players. Each of those renders its own notice rather than an error.
 */
export const SlatePage = (): JSX.Element => {
  const [date, setDate] = useState(todayInEastern);

  const { data, loading, error, reload } = useCachedResource<SlateResponse>(
    `slate:${date}`,
    () => getSlate(date),
    { errorMessage: 'Failed to load the slate' }
  );

  const predictedAt = formatTimestamp(data?.run?.predicted_at ?? null);
  const baseline = data?.baseline ?? null;
  // 0 disables the chips, which is what an older server (or one caught
  // mid-deploy) that sends no baseline descriptor should produce.
  const notableMinDelta = baseline?.definition ? baseline.notable_min_delta : 0;

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="font-bold text-xl sm:text-2xl leading-tight flex items-center gap-2">
            <CalendarDays size={20} className="opacity-60" />
            Today&apos;s Projections
          </h1>
          <p className="text-sm opacity-60 mt-0.5">
            {formatSlateDate(data?.date ?? date)}
            {data?.run && (
              <>
                <span className="opacity-40"> · </span>
                model {data.run.model_version}
                {predictedAt && ` · run ${predictedAt}`}
              </>
            )}
          </p>
        </div>

        <label className="form-control">
          <span className="sr-only">Game date</span>
          <input
            type="date"
            className="input input-bordered input-sm"
            value={date}
            aria-label="Game date"
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
            <p className="text-error text-sm">{error || 'Failed to load the slate'}</p>
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

          {data.games.length === 0 ? (
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-12 gap-1">
                <p className="text-sm font-semibold">No games scheduled</p>
                <p className="text-xs opacity-60 max-w-md">
                  Nothing on the schedule for {formatSlateDate(data.date)}. Pick another date, or
                  check{' '}
                  <Link to="/watchlist" className="link link-primary">
                    the watchlist
                  </Link>
                  .
                </p>
              </div>
            </div>
          ) : (
            <>
              {data.run && (
                <div
                  className="text-[11px] opacity-70 flex items-center gap-x-4 gap-y-1 flex-wrap"
                  data-testid="slate-legend"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="badge badge-primary badge-sm tabular-nums font-semibold">
                      +11.2
                    </span>
                    <span>projected impact, 0 = average night</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="badge badge-success badge-sm tabular-nums">87%</span>
                    <span>chance he plays</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Flame size={13} className="text-primary" />
                    <span>slate standout</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="badge badge-xs badge-error uppercase tracking-wide">
                      Out<span className="font-bold normal-case">&nbsp;· new</span>
                    </span>
                    <span>injury report now; &quot;new&quot; = changed after this projection</span>
                  </span>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.games.map((game) => (
                  <GameCard
                    key={game.nba_game_id}
                    game={game}
                    notableMinDelta={notableMinDelta}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <footer className="text-[11px] opacity-40 mt-6 pt-3 border-t border-base-300 flex flex-col gap-1">
        <span>
          Players and games are ordered by projected impact across all nine categories. 0 is an
          average night.
        </span>
        <span>
          Every projection already accounts for the chance he sits, as of when it was
          published. The injury chip is the report right now.
        </span>
      </footer>
    </div>
  );
};
