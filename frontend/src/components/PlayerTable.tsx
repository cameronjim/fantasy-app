import { useState, useEffect } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Player } from '../types';

interface PlayerTableProps {
  players: Player[];
  onSelect: (player: Player) => void;
  selectedForCompare?: Player[];
  onToggleCompare?: (player: Player) => void;
}

type SortKey = keyof Player;

const columns: { key: SortKey; label: string; format?: (v: number) => string }[] = [
  { key: 'name', label: 'Player' },
  { key: 'team', label: 'Team' },
  { key: 'position', label: 'Pos' },
  { key: 'ppg', label: 'PPG', format: (v) => Number(v).toFixed(1) },
  { key: 'rpg', label: 'RPG', format: (v) => Number(v).toFixed(1) },
  { key: 'apg', label: 'APG', format: (v) => Number(v).toFixed(1) },
  { key: 'spg', label: 'SPG', format: (v) => Number(v).toFixed(1) },
  { key: 'bpg', label: 'BPG', format: (v) => Number(v).toFixed(1) },
  { key: 'fg_pct', label: 'FG%', format: (v) => Number(v).toFixed(1) },
  { key: 'three_pct', label: '3P%', format: (v) => Number(v).toFixed(1) },
  { key: 'ft_pct', label: 'FT%', format: (v) => Number(v).toFixed(1) },
  { key: 'tov', label: 'TOV', format: (v) => Number(v).toFixed(1) },
  { key: 'mpg', label: 'MIN', format: (v) => Number(v).toFixed(1) },
  { key: 'gp', label: 'GP' },
];

const PAGE_SIZE = 25;

const FALLBACK_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23252836'/%3E%3Ccircle cx='20' cy='15' r='7' fill='%234b5563'/%3E%3Cellipse cx='20' cy='35' rx='12' ry='8' fill='%234b5563'/%3E%3C/svg%3E";

export default function PlayerTable({ players, onSelect, selectedForCompare = [], onToggleCompare }: PlayerTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('ppg');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  useEffect(() => { setPage(0); }, [players.length]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'team' || key === 'position' ? 'asc' : 'desc');
    }
    setPage(0);
  };

  const numericKeys = new Set(['ppg','rpg','apg','spg','bpg','fg_pct','three_pct','ft_pct','tov','mpg','gp']);

  const sorted = [...players].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (numericKeys.has(sortKey)) {
      const diff = Number(aVal) - Number(bVal);
      return sortDir === 'asc' ? diff : -diff;
    }
    return sortDir === 'asc'
      ? String(aVal).localeCompare(String(bVal))
      : String(bVal).localeCompare(String(aVal));
  });

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const compareIds = new Set(selectedForCompare.map((p) => p.id));
  const compareMaxed = selectedForCompare.length >= 3;

  const injuryBadgeClass = (status: string) => {
    if (status === 'Out') return 'badge badge-error badge-xs';
    if (['Day-To-Day', 'Day_To_Day', 'Questionable'].includes(status)) return 'badge badge-warning badge-xs';
    if (status === 'Probable') return 'badge badge-success badge-xs';
    return 'badge badge-error badge-xs';
  };

  const pageItems = Array.from({ length: totalPages }, (_, i) => i)
    .filter((i) => i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 2)
    .reduce<(number | 'ellipsis')[]>((acc, i, idx, arr) => {
      if (idx > 0 && arr[idx - 1] !== i - 1) acc.push('ellipsis');
      acc.push(i);
      return acc;
    }, []);

  return (
    <div>
      <div className="overflow-x-auto rounded-box border border-base-300">
        <table className="table table-zebra table-sm w-full">
          <thead>
            <tr>
              {onToggleCompare && <th className="w-8" />}
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className="cursor-pointer select-none whitespace-nowrap"
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key && (
                      sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((player) => {
              const isSelected = compareIds.has(player.id);
              const isDisabled = onToggleCompare && compareMaxed && !isSelected;
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
                  {columns.map((col) => (
                    <td key={col.key} className="whitespace-nowrap">
                      {col.key === 'name' ? (
                        <span className="flex items-center gap-2">
                          <div className="avatar">
                            <div className="w-7 rounded-full">
                              <img
                                src={player.headshot_url || FALLBACK_SVG}
                                alt=""
                                onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_SVG; }}
                              />
                            </div>
                          </div>
                          <span className="font-medium">{player.name}</span>
                          {player.injury_status && (
                            <span className={injuryBadgeClass(player.injury_status)}>
                              {player.injury_status.replace(/_/g, ' ')}
                            </span>
                          )}
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
            {paginated.length === 0 && (
              <tr>
                <td colSpan={columns.length + (onToggleCompare ? 1 : 0)} className="text-center py-12 opacity-40">
                  No players found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 px-1">
          <span className="text-xs opacity-40">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="join">
            <button
              className="join-item btn btn-xs"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft size={14} />
            </button>
            {pageItems.map((item, idx) =>
              item === 'ellipsis' ? (
                <button key={`e${idx}`} className="join-item btn btn-xs btn-disabled">…</button>
              ) : (
                <button
                  key={item}
                  onClick={() => setPage(item)}
                  className={`join-item btn btn-xs ${page === item ? 'btn-primary' : ''}`}
                >
                  {item + 1}
                </button>
              )
            )}
            <button
              className="join-item btn btn-xs"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
