import { SEASON_STAT_COLUMNS } from '../utils/seasonColumns';
import { formatStat, formatText } from '../utils/stats';
import { usePlayerCareer } from '../hooks/usePlayerCareer';

const HEADING = 'Career by Season';

interface PlayerCareerSectionProps {
  // stats.nba.com id; null for players without one, which skips the lookup.
  nbaPlayerId: string | null | undefined;
  /**
   * Shown instead of nothing when there is no history. Only for surfaces the
   * user opened ON PURPOSE to see the history: a dedicated dialog that renders
   * empty is a bug, whereas the player modal is better off silently dropping a
   * section the player has no data for.
   */
  emptyMessage?: string;
  /**
   * Wraps the section in the same card the analytics page gives every other
   * section, with a matching heading. Off by default because inside a modal it
   * is one block among plain ones, and a card there would be the odd one out.
   */
  framed?: boolean;
}

/**
 * Season-by-season career history. Renders nothing at all when the player has
 * no ingested history, so a host surface is unchanged for everyone until the
 * historical backfill has been run, unless it passes `emptyMessage`.
 */
export const PlayerCareerSection = ({
  nbaPlayerId,
  emptyMessage,
  framed = false,
}: PlayerCareerSectionProps): JSX.Element | null => {
  const { seasons, loading, unavailable } = usePlayerCareer(nbaPlayerId);

  // one wrapper for every branch, so a framed host never gets a bare spinner or
  // a heading-less table sitting outside its card.
  const frame = (heading: boolean, body: JSX.Element): JSX.Element => {
    if (framed) {
      return (
        <section className="card bg-base-200 border border-base-300">
          <div className="card-body p-4 sm:p-5 gap-3">
            {heading && <h2 className="font-bold text-base">{HEADING}</h2>}
            {body}
          </div>
        </section>
      );
    }
    return (
      <div className="mb-4">
        {heading && (
          <p className="text-xs font-semibold opacity-40 uppercase tracking-wider mb-2">
            {HEADING}
          </p>
        )}
        {body}
      </div>
    );
  };

  if (loading) {
    return frame(
      false,
      <div className="flex items-center gap-2 py-2">
        <span className="loading loading-spinner loading-xs opacity-40" />
        <span className="text-xs opacity-40">Loading career history…</span>
      </div>
    );
  }

  if (unavailable) {
    if (!emptyMessage) return null;
    return frame(false, <p className="text-sm opacity-50 py-4">{emptyMessage}</p>);
  }

  return frame(
    true,
    /* both axes scroll inside the box: wide stat rows never widen the host and a
       20-season career never makes it taller than the viewport. */
    <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-box border border-base-300">
      <table className="table table-zebra table-xs table-fixed table-pin-rows min-w-[900px] w-full">
        <thead>
          <tr>
            <th title="Season" className="whitespace-nowrap w-[86px]">Season</th>
            <th title="Team" className="whitespace-nowrap w-[60px]">Team</th>
            {SEASON_STAT_COLUMNS.map((col) => (
              <th key={col.key} title={col.full} className={`whitespace-nowrap ${col.w}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seasons.map((row) => (
            <tr key={`${row.season}-${row.team ?? ''}`}>
              <td className="whitespace-nowrap font-medium">{row.season}</td>
              <td className="whitespace-nowrap">{formatText(row.team)}</td>
              {SEASON_STAT_COLUMNS.map((col) => (
                <td key={col.key} className="whitespace-nowrap tabular-nums">
                  {formatStat(row[col.key], col.decimals)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
