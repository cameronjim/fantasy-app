import { useState, useEffect } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Player } from '../types';

interface PlayerTableProps {
  players: Player[];
  onSelect: (player: Player) => void;
}

type SortKey = keyof Player;

const columns: { key: SortKey; label: string; format?: (v: number) => string }[] = [
  { key: 'name', label: 'Name' },
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

export default function PlayerTable({ players, onSelect }: PlayerTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('ppg');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  // Reset to page 0 when players list changes (filters)
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

  const getInjuryBadge = (player: Player) => {
    if (!player.injury_status) return null;
    const colors: Record<string, string> = {
      Out: 'bg-[#ef4444]/20 text-[#ef4444]',
      Day_To_Day: 'bg-[#f59e0b]/20 text-[#f59e0b]',
      'Day-To-Day': 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Questionable: 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Probable: 'bg-[#22c55e]/20 text-[#22c55e]',
    };
    const colorClass = colors[player.injury_status] || 'bg-[#ef4444]/20 text-[#ef4444]';
    return (
      <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${colorClass}`}>
        {player.injury_status.replace(/_/g, ' ')}
      </span>
    );
  };

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-[#2a2d3a]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#1a1d29] border-b border-[#2a2d3a]">
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className="px-3 py-2.5 text-left text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider cursor-pointer hover:text-white transition-colors select-none whitespace-nowrap"
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key && (
                      sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((player, i) => (
              <tr
                key={player.id}
                onClick={() => onSelect(player)}
                className={`border-b border-[#2a2d3a] cursor-pointer transition-colors hover:bg-[#2a2d3a] ${
                  i % 2 === 0 ? 'bg-[#0f1117]' : 'bg-[#151822]'
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2.5 whitespace-nowrap ${
                      col.key === 'name' ? 'font-medium text-white' : 'text-[#d1d5db]'
                    }`}
                  >
                    {col.key === 'name' ? (
                      <span className="flex items-center">
                        {player.name}
                        {getInjuryBadge(player)}
                      </span>
                    ) : col.format && player[col.key] != null ? (
                      col.format(player[col.key] as number)
                    ) : (
                      String(player[col.key] ?? '-')
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-[#6b7280]">
                  No players found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 px-1">
          <span className="text-xs text-[#6b7280]">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1.5 rounded-md bg-[#1a1d29] border border-[#2a2d3a] text-[#9ca3af] hover:text-white hover:border-[#3b82f6] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronLeft size={14} />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i)
              .filter(i => i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 2)
              .reduce<(number | 'ellipsis')[]>((acc, i, idx, arr) => {
                if (idx > 0 && arr[idx - 1] !== i - 1) acc.push('ellipsis');
                acc.push(i);
                return acc;
              }, [])
              .map((item, idx) =>
                item === 'ellipsis' ? (
                  <span key={`e${idx}`} className="px-1 text-[#6b7280] text-xs">...</span>
                ) : (
                  <button
                    key={item}
                    onClick={() => setPage(item)}
                    className={`min-w-[28px] h-7 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                      page === item
                        ? 'bg-[#3b82f6] text-white'
                        : 'bg-[#1a1d29] border border-[#2a2d3a] text-[#9ca3af] hover:text-white hover:border-[#3b82f6]'
                    }`}
                  >
                    {item + 1}
                  </button>
                )
              )}
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 rounded-md bg-[#1a1d29] border border-[#2a2d3a] text-[#9ca3af] hover:text-white hover:border-[#3b82f6] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
