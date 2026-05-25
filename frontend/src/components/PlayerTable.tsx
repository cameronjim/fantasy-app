import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { Player } from '../types';
import { getTeamLogoUrl } from '../utils/teamLogos';

interface PlayerTableProps {
  players: Player[];
  onSelect: (player: Player) => void;
  selectedForCompare?: Player[];
  onToggleCompare?: (player: Player) => void;
}

type SortKey = keyof Player;

// Fixed pixel widths. The table uses `table-layout: fixed` below so these
// widths are authoritative — content that doesn't fit is truncated. Sorting
// can never resize a column.
const COLUMNS: { key: SortKey; label: string; format?: (v: number) => string; w: string }[] = [
  { key: 'name',                   label: 'Player', w: 'w-[220px]' },
  { key: 'team',                   label: 'Team',   w: 'w-[78px]' },
  { key: 'position',               label: 'Pos',    w: 'w-[60px]' },
  { key: 'points_per_game',        label: 'PPG',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'rebounds_per_game',      label: 'RPG',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'assists_per_game',       label: 'APG',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'steals_per_game',        label: 'SPG',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'blocks_per_game',        label: 'BPG',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'field_goal_percentage',  label: 'FG%',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'three_point_percentage', label: '3P%',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'free_throw_percentage',  label: 'FT%',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'turnovers_per_game',     label: 'TOV',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'minutes_per_game',       label: 'MIN',    w: 'w-[64px]', format: (v) => Number(v).toFixed(1) },
  { key: 'games_played',           label: 'GP',     w: 'w-[58px]' },
];

// Sum of all column widths + ~40px for the optional compare checkbox.
// Used as the table's min-width so it horizontally scrolls on narrow screens
// instead of squishing columns.
const TABLE_MIN_WIDTH = '1130px';

// How many rows to render initially, and how many more to add each time
// the user scrolls within INFINITE_THRESHOLD pixels of the bottom.
const INITIAL_ROWS = 30;
const ROW_INCREMENT = 30;
const INFINITE_THRESHOLD = 600;

const FALLBACK_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23252836'/%3E%3Ccircle cx='20' cy='15' r='7' fill='%234b5563'/%3E%3Cellipse cx='20' cy='35' rx='12' ry='8' fill='%234b5563'/%3E%3C/svg%3E";

const NUMERIC_KEYS = new Set([
  'points_per_game', 'rebounds_per_game', 'assists_per_game', 'steals_per_game',
  'blocks_per_game', 'field_goal_percentage', 'three_point_percentage',
  'free_throw_percentage', 'turnovers_per_game', 'minutes_per_game', 'games_played',
]);

export const PlayerTable = ({ players, onSelect, selectedForCompare = [], onToggleCompare }: PlayerTableProps) => {
  const [sortKey, setSortKey] = useState<SortKey>('points_per_game');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset the visible window whenever the filter/sort result changes
  // so users don't open the page already 200 rows deep.
  useEffect(() => { setVisibleCount(INITIAL_ROWS); }, [players.length, sortKey, sortDir]);

  const sorted = useMemo(() => {
    return [...players].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (NUMERIC_KEYS.has(sortKey)) {
        const diff = Number(aVal) - Number(bVal);
        return sortDir === 'asc' ? diff : -diff;
      }
      return sortDir === 'asc'
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
  }, [players, sortKey, sortDir]);

  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  // IntersectionObserver bumps visibleCount whenever the sentinel scrolls into view.
  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + ROW_INCREMENT, sorted.length));
        }
      },
      { rootMargin: `0px 0px ${INFINITE_THRESHOLD}px 0px` }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, sorted.length]);

  const handleSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'team' || key === 'position' ? 'asc' : 'desc');
    }
  };

  const compareIds = new Set(selectedForCompare.map((p) => p.id));
  const compareMaxed = selectedForCompare.length >= 3;

  const injuryBadgeClass = (status: string): string => {
    if (status === 'Out') return 'badge badge-error badge-xs';
    if (['Day-To-Day', 'Day_To_Day', 'Questionable'].includes(status)) return 'badge badge-warning badge-xs';
    if (status === 'Probable') return 'badge badge-success badge-xs';
    return 'badge badge-error badge-xs';
  };

  return (
    <div>
      <div className="overflow-x-auto rounded-box border border-base-300">
        {/* table-fixed makes the browser use the header widths only, ignoring
            content size — so re-sorting can never change column widths. */}
        <table
          className="table table-zebra table-sm"
          style={{ tableLayout: 'fixed', minWidth: TABLE_MIN_WIDTH, width: '100%' }}
        >
          <thead>
            <tr>
              {onToggleCompare && <th className="w-10" />}
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`cursor-pointer select-none whitespace-nowrap ${col.w}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key
                      ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                      : <ChevronUp size={12} className="invisible" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((player) => {
              const isSelected = compareIds.has(player.id);
              const isDisabled = onToggleCompare && compareMaxed && !isSelected;
              const teamLogo = getTeamLogoUrl(player.team);
              return (
                <tr
                  key={player.id}
                  onClick={() => onSelect(player)}
                  className={`cursor-pointer hover ${isSelected ? 'bg-primary/10' : ''}`}
                >
                  {onToggleCompare && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!!isDisabled}
                        onChange={() => onToggleCompare(player)}
                        className="checkbox checkbox-primary checkbox-xs"
                      />
                    </td>
                  )}
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      className={`whitespace-nowrap ${col.format ? 'tabular-nums' : ''}`}
                    >
                      {col.key === 'name' ? (
                        <span className="flex items-center gap-2 overflow-hidden">
                          <div className="avatar flex-shrink-0">
                            <div className="w-7 rounded-full">
                              <img
                                src={player.headshot_url || FALLBACK_SVG}
                                alt=""
                                onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_SVG; }}
                              />
                            </div>
                          </div>
                          {/* truncate so unusually long names don't reflow the column */}
                          <span className="font-medium truncate" title={player.name}>{player.name}</span>
                          {player.injury_status && (
                            <span className={`flex-shrink-0 ${injuryBadgeClass(player.injury_status)}`}>
                              {player.injury_status.replace(/_/g, ' ')}
                            </span>
                          )}
                        </span>
                      ) : col.key === 'team' ? (
                        <span className="flex items-center gap-1.5">
                          {teamLogo && (
                            <img
                              src={teamLogo}
                              alt=""
                              className="w-4 h-4 object-contain"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          )}
                          <span>{player.team}</span>
                        </span>
                      ) : col.format && player[col.key] != null ? (
                        col.format(player[col.key] as number)
                      ) : (
                        String(player[col.key] ?? '-')
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + (onToggleCompare ? 1 : 0)} className="text-center py-12 opacity-40">
                  No players found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div ref={sentinelRef} className="flex items-center justify-center py-4">
          <span className="loading loading-spinner loading-sm opacity-40" />
        </div>
      )}

      {!hasMore && sorted.length > INITIAL_ROWS && (
        <div className="text-center text-xs opacity-30 py-3">
          {sorted.length} player{sorted.length !== 1 ? 's' : ''} total
        </div>
      )}
    </div>
  );
};
