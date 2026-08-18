import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarRange, TrendingUp } from 'lucide-react';
import { getWatchlist } from '../api/client';
import { useCachedResource } from '../hooks/useCachedResource';
import { formatStat, toStatNumber } from '../utils/stats';
import { availabilityBadge } from '../utils/predictions';
import { SegmentedFilter, type SegmentedOption } from '../components/SegmentedFilter';
import type {
  DeviationStat,
  UpsideDriver,
  WatchlistEvidence,
  WatchlistGame,
  WatchlistPlayer,
  WatchlistPositionFilter,
  WatchlistReason,
  WatchlistResponse,
} from '../types';

/**
 * The big-night detector, over a window the manager chooses.
 *
 * Every row answers ONE question: over the next N days, is he projected to do
 * more than he usually does, often enough for it to matter? So the row's headline
 * is the pair of deltas — "22 → 31 min", "+8.4 pts vs usual" — and the COUNT OF
 * GAMES, not the score. The score is a ranking device; the deltas and the game
 * count are the claim, and they are the part a reader can check.
 *
 * ================= WHY THE GAME COUNT IS PRINTED SO LOUDLY =================
 * The window exists for one use case: a starter is out for two weeks and a
 * manager needs a temporary replacement AT HIS POSITION. In that decision, four
 * ordinary games beat two good ones — the ranking is a SUM over the window
 * precisely so it can say so — and a row that showed only a score would look
 * like it had ranked the wrong player. "4 games this week" is the argument, so
 * it goes next to the name rather than inside the expanded evidence.
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

/**
 * The windows the picker offers.
 *
 * Four presets rather than a number input, because the question is never "how
 * about 9 days" — it is "tonight", "this weekend", "the week he is out" or "the
 * fortnight he is out". `games` is the phrase the row uses for its game count, so
 * "4 games this week" reads as English rather than as "4 games in 7 days".
 */
const WINDOW_OPTIONS: Array<{ days: number; label: string; games: string }> = [
  { days: 1, label: 'Tonight', games: 'tonight' },
  { days: 3, label: '3 days', games: 'in 3 days' },
  { days: 7, label: 'Week', games: 'this week' },
  { days: 14, label: '2 weeks', games: 'in 2 weeks' },
];

const DEFAULT_WINDOW_DAYS = 1;

function windowOption(days: number): { days: number; label: string; games: string } {
  return WINDOW_OPTIONS.find((option) => option.days === days) ?? WINDOW_OPTIONS[0];
}

/**
 * The position filter's primary row: the exact positions plus centre, in the
 * same order and look as the Stats page's own position control (see
 * StatsPage.tsx's `POSITIONS`) — 'All' | PG | SG | SF | PF | C. Centre has no
 * finer split on either page, so it sits in this row rather than the roster
 * bucket row below.
 */
const POSITION_PRIMARY: WatchlistPositionFilter[] = ['PG', 'SG', 'SF', 'PF', 'C'];

/**
 * Roster-slot buckets with no Stats-page equivalent. Kept as a second,
 * visually smaller row instead of being folded into the primary six segments
 * — a manager filling a hole "at guard" still gets that option, it just does
 * not pretend to be one of the Stats page's six positions.
 */
const POSITION_SECONDARY: WatchlistPositionFilter[] = ['G', 'F'];

/** Prose labels — used in sentences ("Showing centers only"), not on chips. */
const POSITION_LABELS: Record<WatchlistPositionFilter, string> = {
  G: 'Guards',
  F: 'Forwards',
  C: 'Centers',
  PG: 'PG',
  SG: 'SG',
  SF: 'SF',
  PF: 'PF',
};

function todayInEastern(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** "Oct 20" — short enough to sit in a table of five games. */
function shortDay(iso: string): string {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

/** "Oct 20" for a single day, "Oct 20 – Oct 26" for a window. */
function formatRange(from: string, to: string): string {
  return from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
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

/**
 * His position, next to the name. Rendered as its own chip rather than appended
 * to the team abbreviation so a position filter has something visible to be
 * checked against, and so the "unknown position" case can say so in words.
 */
const PositionChip = ({ position }: { position: string | null }): JSX.Element => {
  if (position === null) {
    return (
      <span
        className="badge badge-ghost badge-sm opacity-50 shrink-0"
        title="The run projects him but the roster table has no position for him, so a position filter cannot include him"
      >
        pos ?
      </span>
    );
  }
  return (
    <span
      className="badge badge-outline badge-sm shrink-0 font-semibold"
      title={`Listed at ${position.split('/').join(' and ')}. A combo player answers every one of his positions.`}
    >
      {position}
    </span>
  );
};

/**
 * The games-in-window count — the streaming argument, so it is a filled badge on
 * the summary line rather than a number in the expanded evidence. Hidden for a
 * one-day window, where "1 game tonight" is not news.
 */
const GamesCount = ({
  count,
  phrase,
  days,
}: {
  count: number;
  phrase: string;
  days: number;
}): JSX.Element | null => {
  if (days <= 1) return null;
  return (
    <span
      className="badge badge-primary badge-sm tabular-nums whitespace-nowrap"
      title={`The run projects ${count} game${count === 1 ? '' : 's'} for him inside this window. The score is the SUM over those games, so more games is worth more — that is the whole point of picking a window.`}
    >
      {count} game{count === 1 ? '' : 's'} {phrase}
    </span>
  );
};

/**
 * Every game in the window, with what each one contributes. This is where a
 * reader checks the sum: a row claiming five games should show five, and the
 * flat ones should show a 0 they can see rather than infer.
 */
const GameBreakdown = ({ games }: { games: WatchlistGame[] }): JSX.Element | null => {
  if (games.length === 0) return null;
  return (
    <table className="table table-xs w-auto">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider opacity-50">
          <th className="font-normal">Date</th>
          <th className="font-normal">Opp</th>
          <th className="font-normal text-right">Min</th>
          <th className="font-normal text-right">Pts</th>
          <th className="font-normal text-right">Impact</th>
          <th className="font-normal text-right">Adds</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {games.map((game) => (
          <tr key={`${game.game_date}-${game.nba_game_id}`}>
            <td className="whitespace-nowrap">{shortDay(game.game_date)}</td>
            <td className="uppercase opacity-60">{game.opponent_team_abbr ?? '—'}</td>
            <td className="text-right">{formatStat(game.minutes_p50, 0)}</td>
            <td className="text-right">{formatStat(game.proj_pts)}</td>
            <td className="text-right opacity-60">{formatStat(game.impact)}</td>
            <td
              className={
                'text-right ' + ((toStatNumber(game.score) ?? 0) > 0 ? 'font-semibold' : 'opacity-40')
              }
            >
              {formatStat(game.score, 2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Human-readable lines for whichever evidence keys the server sent. */
function evidenceLines(
  player: WatchlistPlayer,
  evidence: WatchlistEvidence,
  days: number
): string[] {
  const lines: string[] = [];
  const multi = days > 1;
  // over a window every per-game number on the row is a mean, so the wording has
  // to say so rather than let a reader read it as one night's projection.
  const per = multi ? ' per game' : '';

  const minutesDelta = toStatNumber(player.minutes.delta);
  if (minutesDelta !== null) {
    lines.push(
      `Minutes: ${formatStat(player.minutes.projected)} projected${per} against a ${formatStat(player.minutes.usual)} average over his last ${player.baseline_games} games played (${minutesDelta > 0 ? '+' : ''}${formatStat(minutesDelta)})`
    );
  }
  if (multi) {
    lines.push(
      `Window: ${player.games_count} game${player.games_count === 1 ? '' : 's'} projected, adding up to a ${formatStat(player.score, 2)} total at ${formatStat(player.score_per_game, 2)} a game — the ranking sums the games, so volume counts`
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
    const scope = multi
      ? `projected total impact across the window, averaging the ${formatStat(player.impact_percentile, 0)}th percentile of a night's slate`
      : `projected total impact tonight, the ${formatStat(player.impact_percentile, 0)}th percentile of the slate`;
    lines.push(
      `Absolute floor: ${impact > 0 ? '+' : ''}${impact.toFixed(1)} ${scope} — each game's score is multiplied by that standing, so a big jump by a player who cannot produce scores nothing`
    );
  }

  return lines;
}

const CandidateRow = ({
  player,
  rank,
  days,
}: {
  player: WatchlistPlayer;
  rank: number;
  days: number;
}): JSX.Element => {
  const lines = evidenceLines(player, player.evidence, days);
  const impact = toStatNumber(player.impact);
  const option = windowOption(days);
  const multi = days > 1;

  return (
    <li className="border border-base-300 rounded-box bg-base-200">
      <details className="group">
        <summary className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 cursor-pointer list-none">
          <span className="text-xs tabular-nums opacity-40 w-6 shrink-0">{rank}</span>

          {/* `basis-full` up to `sm` is what makes the row wrap instead of
              overflow on a phone: with `min-w-0` alone this column shrinks to
              nothing to keep the badges on one line, which truncated the name
              away entirely and let a nowrap badge spill over its neighbour. */}
          <span className="min-w-0 basis-full sm:basis-0 grow flex flex-col gap-0.5">
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
              <PositionChip position={player.position} />
              <span className="text-[11px] opacity-50 uppercase tracking-wider shrink-0">
                {player.team_abbr ?? '—'}
                {/* over a window there is no single opponent to name — the
                    breakdown lists them instead. */}
                {!multi && player.opponent_team_abbr && (
                  <>
                    <span className="opacity-50 lowercase"> vs </span>
                    {player.opponent_team_abbr}
                  </>
                )}
              </span>
            </span>
            {/* the game count shares the deltas' line rather than the name's:
                on a phone the name would otherwise be truncated to make room
                for it, and the name is the one thing a row cannot lose. */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <GamesCount count={player.games_count} phrase={option.games} days={days} />
              <DeltaPair player={player} />
            </span>
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
              title={
                multi
                  ? "Projected total fantasy impact summed over the window, each night measured against that night's slate. 0 is an average night."
                  : 'Projected total fantasy impact tonight, against the whole slate. 0 is an average night — the same number the Projections tab ranks by.'
              }
            >
              {impact > 0 ? '+' : ''}
              {impact.toFixed(1)}
            </span>
          )}

          <AvailabilityBadge value={player.prob_active} />

          <span
            className="text-sm font-bold tabular-nums w-10 text-right"
            title={
              multi
                ? `Window total: every game's gap above his own usual, weighted by how much that night's impact matters, added up. ${formatStat(player.score_per_game, 2)} a game across ${player.games_count}.`
                : "How far above his own usual, times how much tonight's absolute impact matters"
            }
          >
            {formatStat(player.score, 2)}
          </span>
        </summary>

        <div className="px-3 pb-3 pt-0 flex flex-col gap-2">
          {lines.length > 0 && (
            <ul
              className="flex flex-col gap-1"
              data-testid={`evidence-${player.nba_player_id}`}
            >
              {lines.map((line) => (
                <li key={line} className="text-xs opacity-70 pl-6">
                  {line}
                </li>
              ))}
            </ul>
          )}
          {multi && (
            <div className="pl-6 overflow-x-auto" data-testid={`games-${player.nba_player_id}`}>
              <GameBreakdown games={player.games} />
            </div>
          )}
        </div>
      </details>
    </li>
  );
};

const Legend = ({ days }: { days: number }): JSX.Element => (
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
        <li className="flex items-start gap-2">
          <span className="shrink-0">
            <span className="badge badge-outline badge-sm font-semibold">PG/SG</span>
          </span>
          <span className="text-xs opacity-60">
            Every position he is listed at. A combo player answers a filter for each of them, so
            &ldquo;PG/SG&rdquo; shows up under both Guards and PG.
          </span>
        </li>
        {days > 1 && (
          <li className="flex items-start gap-2">
            <span className="shrink-0">
              <span className="badge badge-primary badge-sm">4 games</span>
            </span>
            <span className="text-xs opacity-60">
              Games the run projects for him inside the window. The score adds up his games rather
              than averaging them, so this number is part of the ranking, not decoration.
            </span>
          </li>
        )}
      </ul>
      <p className="text-xs opacity-60 pt-1 border-t border-base-300 mt-1">
        Badges explain a row; they do not rank it. The ranking is how far each projection sits above
        the player&apos;s own recent averages, multiplied by where his absolute projected impact
        stands on that night&apos;s slate. A bench player tripling his minutes scores nothing,
        because the second term is what makes the first one worth acting on.
      </p>
    </div>
  </section>
);

/**
 * The one-line explanation of the ranking, always visible.
 *
 * Not a tooltip: a reader who does not know what the number on the right means
 * will not hover to find out, and the slate page learned that the hard way. The
 * sentence changes with the window because the ranking genuinely changes — over
 * one night it is a product, over a week it is a sum.
 */
const RankingNote = ({ days }: { days: number }): JSX.Element => (
  <p className="text-[11px] opacity-60 flex items-start gap-1.5" data-testid="ranking-note">
    <ArrowUpRight size={13} className="text-success shrink-0 mt-0.5" />
    {days > 1 ? (
      <span>
        Ranked by TOTAL over the window: each projected game earns how far it sits above his own
        recent averages, weighted by how much that night&apos;s absolute impact matters, and the
        games are <strong className="font-semibold">added up</strong>. So a player with more games
        can outrank a better player with fewer — which is the point when you are covering an
        injury. Open a row to see every game and what it adds.
      </span>
    ) : (
      <span>
        Each row shows where his minutes usually sit and where tonight projects. The score on the
        right is that gap, weighted by how much tonight&apos;s absolute impact matters.
      </span>
    )}
  </p>
);

/**
 * The window picker. A segmented control, in the exact look of the Stats
 * page's position/conference joins (see StatsPage.tsx's `SegmentedFilter`
 * usage) — that page is the source of truth for this styling.
 */
const WindowPicker = ({
  days,
  onChange,
}: {
  days: number;
  onChange: (days: number) => void;
}): JSX.Element => (
  <SegmentedFilter
    options={WINDOW_OPTIONS.map((option) => ({ value: option.days, label: option.label }))}
    value={days}
    onChange={onChange}
    ariaLabel="Time window"
  />
);

/**
 * The position filter, restyled to the Stats page's segmented control instead
 * of the pill badges this page used to render. The primary row is exactly the
 * Stats page's look — All | PG | SG | SF | PF | C — so the current filter is
 * visible without opening anything, same as before, but the segments now
 * match the rest of the app. The roster-slot buckets (Guards, Forwards) have
 * no Stats-page equivalent, so they get a second, visually smaller row rather
 * than cluttering the primary six segments.
 */
const PositionPicker = ({
  value,
  options,
  onChange,
}: {
  value: WatchlistPositionFilter | null;
  options: WatchlistPositionFilter[];
  onChange: (value: WatchlistPositionFilter | null) => void;
}): JSX.Element => {
  // only offer what the server said it honours, so a chip can never produce a 400
  const primary = POSITION_PRIMARY.filter((pos) => options.includes(pos));
  const secondary = POSITION_SECONDARY.filter((pos) => options.includes(pos));

  const primaryOptions: SegmentedOption<WatchlistPositionFilter | null>[] = [
    { value: null, label: 'All' },
    ...primary.map((pos) => ({ value: pos, label: pos })),
  ];
  const secondaryOptions: SegmentedOption<WatchlistPositionFilter | null>[] = secondary.map((pos) => ({
    value: pos,
    label: POSITION_LABELS[pos],
  }));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="position-filter">
      <span className="sr-only">Position filter</span>
      <SegmentedFilter options={primaryOptions} value={value} onChange={onChange} ariaLabel="Position" />
      {secondaryOptions.length > 0 && (
        <SegmentedFilter
          options={secondaryOptions}
          value={value}
          onChange={onChange}
          ariaLabel="Roster slot"
        />
      )}
    </div>
  );
};

const NO_CANDIDATES = 'Nobody is projected above their own usual tonight';
const NO_CANDIDATES_WINDOW = 'Nobody is projected above their own usual in this window';
const NO_RUN_NOTICE =
  'No prediction run yet — this page compares projections against each player’s own recent form, so there is nothing to rank until a run completes.';

/**
 * Players projected to do more than they usually do over a window the manager
 * picks, at a position he picks, ranked by how much more times how much it would
 * matter — added up across the window.
 *
 * Every empty answer is a 200 and each renders its own notice: no completed run,
 * a run on which nobody clears both terms, and a run on which nobody AT THE
 * CHOSEN POSITION does are three different states. The last one is the newest and
 * the most confusing without a notice of its own — an empty list under a "Guards"
 * chip must not read as "the model has nothing to say".
 *
 * The window and position live in the cache key, so switching either is a
 * distinct cached resource and flipping back to a window you already looked at
 * renders instantly rather than refetching.
 */
export const WatchlistPage = (): JSX.Element => {
  const [date, setDate] = useState(todayInEastern);
  const [days, setDays] = useState(DEFAULT_WINDOW_DAYS);
  const [position, setPosition] = useState<WatchlistPositionFilter | null>(null);
  // client-side only, unlike `position`: the watchlist never returns more than
  // a couple dozen rows, so filtering by team in the browser is simple and
  // effectively free, and there is no need to round-trip to the server for it
  // the way the Stats page's own team select does not either — that one also
  // filters the already-fetched player list client-side.
  const [teamFilter, setTeamFilter] = useState('');

  const { data, loading, error, reload } = useCachedResource<WatchlistResponse>(
    `watchlist:${date}:${days}:${position ?? 'any'}`,
    () => getWatchlist(date, days, position),
    { errorMessage: 'Failed to load the watchlist' }
  );

  const baseline = data?.baseline ?? null;
  const pool = data?.pool ?? null;
  // the resolved window is the SERVER's, so the page can never describe a window
  // the numbers on screen were not computed over. That matters while a new window
  // is still in flight: the rows still hold the previous payload, and labelling
  // them with the newly-clicked window would caption them wrongly for a moment.
  const from = data?.window.from ?? date;
  const to = data?.window.to ?? date;
  const shownDays = data?.window.days ?? days;
  const positionOptions = data?.position_options ?? POSITION_PRIMARY.concat(POSITION_SECONDARY);
  const unplaced = data?.position_coverage.unknown ?? 0;

  const players = data?.players ?? [];
  const teamAbbrs = [...new Set(players.map((p) => p.team_abbr).filter((t): t is string => t !== null))].sort();
  const visiblePlayers = teamFilter ? players.filter((p) => p.team_abbr === teamFilter) : players;

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-3">
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
          <span className="sr-only">Window start date</span>
          <input
            type="date"
            className="input input-bordered input-sm"
            value={date}
            aria-label="Window start date"
            onChange={(e) => setDate(e.target.value || todayInEastern())}
          />
        </label>
      </header>

      <section className="flex flex-col gap-2 mb-5" aria-label="Window and position">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <WindowPicker days={days} onChange={setDays} />
          <span
            className="text-xs opacity-60 flex items-center gap-1.5 tabular-nums"
            data-testid="window-range"
          >
            <CalendarRange size={13} className="opacity-60" />
            {formatRange(from, to)}
            {shownDays > 1 && <span className="opacity-50">· {shownDays} days</span>}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Same classes as the Stats page's team select — see StatsPage.tsx.
              Client-side only: it filters the rows already on screen rather than
              adding a team parameter to the request. */}
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="select select-bordered select-sm w-[160px]"
            aria-label="Filter by team"
          >
            <option value="">All Teams</option>
            {teamAbbrs.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <PositionPicker value={position} options={positionOptions} onChange={setPosition} />
        </div>
      </section>

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

          {players.length === 0 && data.position !== null ? (
            /* a position filter that emptied the list is its own state: the model
               has plenty to say, just not about this slot. */
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-12 gap-1">
                <p className="text-sm font-semibold">
                  No {POSITION_LABELS[data.position].toLowerCase()} clear the bar{' '}
                  {shownDays > 1 ? 'in this window' : 'tonight'}
                </p>
                <p className="text-xs opacity-60 max-w-md">
                  Nobody at that position is both above his own recent form and high enough on a
                  night&apos;s slate to matter. Try a longer window, a wider slot, or{' '}
                  <button
                    type="button"
                    className="link link-primary"
                    onClick={() => setPosition(null)}
                  >
                    every position
                  </button>
                  .
                  {unplaced > 0 && (
                    <>
                      {' '}
                      {unplaced} projected player{unplaced === 1 ? '' : 's'} could not be considered
                      at all: the roster table has no position for {unplaced === 1 ? 'him' : 'them'}.
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : players.length === 0 ? (
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-12 gap-1">
                <p className="text-sm font-semibold">
                  {shownDays > 1 ? NO_CANDIDATES_WINDOW : NO_CANDIDATES}
                </p>
                <p className="text-xs opacity-60 max-w-md">
                  {data.run
                    ? "Nobody the run projects in this window is both above his own recent form and high enough on a night's slate to matter. That is a normal answer, and a common one on a quiet stretch."
                    : 'Check back after the next model run.'}{' '}
                  <Link to="/projections" className="link link-primary">
                    The projections
                  </Link>{' '}
                  still rank who is best tonight in absolute terms.
                </p>
              </div>
            </div>
          ) : visiblePlayers.length === 0 ? (
            /* the team filter is client-side only, so an empty result here is
               never the model's answer — it is this page's own filter, and the
               escape hatch says so rather than reusing the model's empty states. */
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-8 gap-1">
                <p className="text-sm font-semibold">No {teamFilter} players in this window</p>
                <p className="text-xs opacity-60">
                  <button
                    type="button"
                    className="link link-primary"
                    onClick={() => setTeamFilter('')}
                  >
                    Clear the team filter
                  </button>{' '}
                  to see every team.
                </p>
              </div>
            </div>
          ) : (
            <>
              <RankingNote days={shownDays} />
              {data.position !== null && (
                <p className="text-[11px] opacity-50" data-testid="position-note">
                  Showing {POSITION_LABELS[data.position].toLowerCase()} only, ranked among the whole
                  slate rather than among each other.
                  {unplaced > 0 &&
                    ` ${unplaced} projected player${unplaced === 1 ? '' : 's'} ${unplaced === 1 ? 'has' : 'have'} no position on record and cannot appear under a position filter.`}
                </p>
              )}
              <ul className="flex flex-col gap-2">
                {visiblePlayers.map((player, index) => (
                  <CandidateRow
                    key={player.nba_player_id}
                    player={player}
                    rank={index + 1}
                    days={shownDays}
                  />
                ))}
              </ul>
            </>
          )}

          <Legend days={shownDays} />

          {/* both definitions come from the server, so this page never states a
              window or a pool the numbers were not actually computed against. */}
          <footer className="text-[11px] opacity-40 pt-1 flex flex-col gap-1">
            {baseline?.definition && (
              <span>
                &ldquo;Usual&rdquo; means {baseline.label}: {baseline.definition}. Game logs, not
                season averages, and taken once as of {from} — so a game later in the window is never
                compared against itself.
              </span>
            )}
            {pool?.definition && (
              <span>
                Absolute impact is measured against {pool.label.toLowerCase()}: {pool.definition}
                {pool.sample_size > 0 && ` (${pool.sample_size} player-games)`}.
              </span>
            )}
            {shownDays > 1 && (
              <span>
                A row&apos;s minutes, points and availability are averages over his games in the
                window; its impact, projected totals and score are sums over them. Availability
                reads as the share of these games he is expected to appear in.
              </span>
            )}
          </footer>
        </div>
      )}
    </div>
  );
};
