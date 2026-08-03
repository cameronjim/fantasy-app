import { useState } from 'react';
import { CalendarRange } from 'lucide-react';
import type { PlayerPredictionsResponse, UpcomingGamePrediction } from '../types';
import { statLabel, formatTimestamp } from '../utils/analytics';
import {
  availabilityBadge,
  formatPredictionDate,
  opponentLabel,
  statCellDisplay,
} from '../utils/predictions';

interface PlayerUpcomingGamesProps {
  /** Null while the request is in flight (or after it failed) — renders nothing. */
  data: PlayerPredictionsResponse | null;
}

/** The stat-picker's "don't filter" option. Never a real stat key. */
const ALL_STATS = 'all';

/**
 * Every game the latest model run covers for this player, not just the next
 * one.
 *
 * Two things this section refuses to do, both deliberate:
 *
 *   It never hides a doubtful player's numbers. `prob_active` is shown as its
 *   own badge and the projections stay visible underneath, because "what does
 *   he give me IF he plays" is the question being asked about exactly the
 *   players whose availability is in doubt.
 *
 *   It never hardcodes the stat list. The columns are built from whatever the
 *   run emitted (`data.stats`), so a stat added to the model's emission path
 *   appears here the day it is first written rather than the day someone
 *   remembers to edit this file. The picker exists because that list is
 *   expected to reach nine or ten stats, which is more than a phone can show.
 */
export const PlayerUpcomingGames = ({ data }: PlayerUpcomingGamesProps): JSX.Element | null => {
  const [selected, setSelected] = useState<string>(ALL_STATS);

  if (!data) return null;

  const { run, stats, games } = data;
  // a stat that vanished from a newer run must not leave the table blank.
  const active = selected !== ALL_STATS && stats.includes(selected) ? selected : ALL_STATS;
  const columns = active === ALL_STATS ? stats : [active];

  return (
    <section
      id="upcoming-games"
      data-testid="upcoming-games-section"
      className="card bg-base-200 border border-base-300"
    >
      <div className="card-body p-4 sm:p-5 gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <CalendarRange size={16} className="text-primary" />
            <h2 className="font-bold text-base">Upcoming games</h2>
            {games.length > 0 && (
              <span className="badge badge-sm badge-outline">{games.length} games</span>
            )}
          </div>
          <p className="text-xs opacity-50 mt-0.5">
            Every game the latest model run covers, earliest first. Stat lines are what he&apos;d
            produce <span className="font-semibold">if he plays</span>; the availability badge is a
            model probability, not an official injury designation.
          </p>
        </div>

        {run === null ? (
          <div className="py-8 text-center">
            <p className="text-sm font-semibold">No prediction run published yet</p>
            <p className="text-xs opacity-60 mt-1 max-w-md mx-auto">
              This section fills in once a model run completes. Nothing else on the page depends
              on it.
            </p>
          </div>
        ) : games.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-semibold">No upcoming games for this player in the current run</p>
            <p className="text-xs opacity-60 mt-1 max-w-md mx-auto">
              The run below completed, but it has no scheduled games for him — he may not have been
              on a roster inside the window it scored.
            </p>
          </div>
        ) : (
          <>
            {stats.length > 1 && (
              <div
                role="tablist"
                aria-label="Prediction stat"
                className="flex flex-wrap gap-1 overflow-x-auto no-scrollbar"
              >
                <button
                  role="tab"
                  aria-selected={active === ALL_STATS}
                  onClick={() => setSelected(ALL_STATS)}
                  className={`btn btn-xs ${active === ALL_STATS ? 'btn-primary' : 'btn-ghost'}`}
                >
                  All
                </button>
                {stats.map((stat) => (
                  <button
                    key={stat}
                    role="tab"
                    aria-selected={active === stat}
                    onClick={() => setSelected(stat)}
                    className={`btn btn-xs ${active === stat ? 'btn-primary' : 'btn-ghost'}`}
                  >
                    {statLabel(stat)}
                  </button>
                ))}
              </div>
            )}

            <div className="overflow-x-auto rounded-box border border-base-300">
              <table className="table table-xs w-full" data-testid="upcoming-games-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Opp</th>
                    <th>Availability</th>
                    {columns.map((stat) => (
                      <th key={stat} className="text-right whitespace-nowrap">
                        {statLabel(stat)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {games.map((game) => (
                    <GameRow key={game.nba_game_id} game={game} columns={columns} />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[10px] opacity-50">
              Each cell: the median if he plays, the 10th–90th percentile band under it, and{' '}
              <span className="font-semibold">sched</span> — the same number with the chance of
              sitting already priced in.
            </p>

            <p className="text-[10px] opacity-40">
              {[
                run.model_version ? `model ${run.model_version}` : null,
                formatTimestamp(run.predicted_at)
                  ? `projected ${formatTimestamp(run.predicted_at)}`
                  : null,
                formatTimestamp(run.forecast_cutoff_at)
                  ? `knew nothing after ${formatTimestamp(run.forecast_cutoff_at)}`
                  : null,
                run.horizon ? `horizon ${run.horizon}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </>
        )}
      </div>
    </section>
  );
};

interface GameRowProps {
  game: UpcomingGamePrediction;
  columns: string[];
}

const GameRow = ({ game, columns }: GameRowProps): JSX.Element => {
  const date = formatPredictionDate(game.game_date);
  const badge = availabilityBadge(game.prob_active);

  return (
    <tr data-testid="upcoming-game-row">
      <td className="whitespace-nowrap">
        <span className="font-medium">{date.label}</span>
        {date.weekday && <span className="ml-1 text-[10px] opacity-50">{date.weekday}</span>}
      </td>
      <td className="whitespace-nowrap font-medium">
        {opponentLabel(game.opponent_abbr, game.is_home)}
      </td>
      <td className="whitespace-nowrap">
        <span className="tooltip tooltip-right" data-tip={badge.hint}>
          <span className={`badge badge-sm ${badge.className}`}>{badge.label}</span>
        </span>
        {badge.percentText && (
          <span className="ml-1.5 text-[10px] tabular-nums opacity-50">{badge.percentText}</span>
        )}
      </td>
      {columns.map((stat) => {
        const cell = statCellDisplay(statLabel(stat), game.stats[stat]);
        return (
          <td key={stat} className="text-right whitespace-nowrap">
            {/* the conditional number always leads; the band and the
                schedule-level twin sit under it rather than in the tooltip, so
                nothing load-bearing is hover-only. */}
            <span className="tooltip tooltip-left" data-tip={cell.hint}>
              <span className="font-semibold tabular-nums">{cell.primary}</span>
              {cell.band && (
                <span className="block text-[10px] tabular-nums opacity-60">{cell.band}</span>
              )}
              {cell.unconditional && (
                <span className="block text-[10px] tabular-nums opacity-40">
                  {cell.unconditional} sched
                </span>
              )}
            </span>
          </td>
        );
      })}
    </tr>
  );
};
