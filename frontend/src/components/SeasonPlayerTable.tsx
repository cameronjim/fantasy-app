import { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { PlayerSeasonRow } from '../types';
import { getTeamLogoUrl } from '../utils/teamLogos';
import { SEASON_STAT_COLUMNS, type SeasonStatKey } from '../utils/seasonColumns';
import { compareStats, formatStat, formatText } from '../utils/stats';

interface SeasonPlayerTableProps {
  rows: PlayerSeasonRow[];
  /**
   * Opens the row's player. Optional so the table still renders read-only;
   * rows only look clickable when a handler is actually wired up.
   */
  onSelect?: (row: PlayerSeasonRow) => void;
}

type SortKey = SeasonStatKey | 'player_name' | 'team';

const TEXT_KEYS: SortKey[] = ['player_name', 'team'];

export const SeasonPlayerTable = ({ rows, onSelect }: SeasonPlayerTableProps): JSX.Element => {
  const [sortKey, setSortKey] = useState<SortKey>('points_per_game');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sortKey === 'player_name' || sortKey === 'team') {
        const aVal = a[sortKey] ?? '';
        const bVal = b[sortKey] ?? '';
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return compareStats(a[sortKey], b[sortKey], sortDir);
    });
  }, [rows, sortKey, sortDir]);

  const handleSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(TEXT_KEYS.includes(key) ? 'asc' : 'desc');
    }
  };

  const sortIcon = (key: SortKey): JSX.Element => {
    if (sortKey !== key) {
      // always rendered, just hidden — an absent icon would change the
      // column's content width when sorting moved to another column.
      return <ChevronUp size={12} className="invisible" />;
    }
    return sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  };

  return (
    <div>
      <div className="overflow-x-auto rounded-box border border-base-300">
        {/* table-fixed makes the browser honor the header widths only, so
            re-sorting can never change column widths. */}
        <table className="table table-zebra table-sm table-fixed min-w-[1100px] w-full">
          <thead>
            <tr>
              <th
                onClick={() => handleSort('player_name')}
                title="Player Name"
                className="cursor-pointer select-none whitespace-nowrap w-[220px]"
              >
                <span className="inline-flex items-center gap-1">
                  Player
                  {sortIcon('player_name')}
                </span>
              </th>
              <th
                onClick={() => handleSort('team')}
                title="Team"
                className="cursor-pointer select-none whitespace-nowrap w-[78px]"
              >
                <span className="inline-flex items-center gap-1">
                  Team
                  {sortIcon('team')}
                </span>
              </th>
              {SEASON_STAT_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  title={col.full}
                  className={`cursor-pointer select-none whitespace-nowrap ${col.w}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sortIcon(col.key)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const teamLogo = row.team ? getTeamLogoUrl(row.team) : null;
              return (
                <tr
                  key={`${row.nba_player_id}-${row.season}-${row.team ?? ''}`}
                  className={`hover ${onSelect ? 'cursor-pointer' : ''}`}
                  onClick={onSelect ? () => onSelect(row) : undefined}
                >
                  <td className="whitespace-nowrap">
                    {/* truncate so unusually long names don't reflow the column */}
                    <span className="font-medium truncate block" title={row.player_name}>
                      {row.player_name}
                    </span>
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      {teamLogo && (
                        <img
                          src={teamLogo}
                          alt=""
                          className="w-4 h-4 object-contain"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      <span>{formatText(row.team)}</span>
                    </span>
                  </td>
                  {SEASON_STAT_COLUMNS.map((col) => (
                    <td key={col.key} className="whitespace-nowrap tabular-nums">
                      {formatStat(row[col.key], col.decimals)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={SEASON_STAT_COLUMNS.length + 2} className="text-center py-12 opacity-40">
                  No players found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {sorted.length > 0 && (
        <div className="text-center text-xs opacity-30 py-3">
          {sorted.length} player{sorted.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
};
