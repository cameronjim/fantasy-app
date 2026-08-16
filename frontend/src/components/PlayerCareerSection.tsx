import { SEASON_STAT_COLUMNS } from '../utils/seasonColumns';
import { formatStat, formatText } from '../utils/stats';
import { usePlayerCareer } from '../hooks/usePlayerCareer';

interface PlayerCareerSectionProps {
  // stats.nba.com id; null for players without one, which skips the lookup.
  nbaPlayerId: string | null | undefined;
}

/**
 * Season-by-season career history for the player modal. Renders nothing at
 * all when the player has no ingested history, so the modal is unchanged for
 * everyone until the historical backfill has been run.
 */
export const PlayerCareerSection = ({ nbaPlayerId }: PlayerCareerSectionProps): JSX.Element | null => {
  const { seasons, loading, unavailable } = usePlayerCareer(nbaPlayerId);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <span className="loading loading-spinner loading-xs opacity-40" />
        <span className="text-xs opacity-40">Loading career history…</span>
      </div>
    );
  }

  if (unavailable) return null;

  return (
    <div className="mb-4">
      <p className="text-xs font-semibold opacity-40 uppercase tracking-wider mb-2">
        Career by Season
      </p>
      {/* both axes scroll inside the box: wide stat rows never widen the modal
          and a 20-season career never makes it taller than the viewport. */}
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
    </div>
  );
};
