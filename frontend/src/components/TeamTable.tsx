import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { Team } from '../types';

interface TeamTableProps {
  teams: Team[];
}

type SortKey = keyof Team;

const columns: { key: SortKey; label: string; format?: (v: number) => string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'wins', label: 'W' },
  { key: 'losses', label: 'L' },
  { key: 'ppg', label: 'PPG', format: (v) => Number(v).toFixed(1) },
  { key: 'rpg', label: 'RPG', format: (v) => Number(v).toFixed(1) },
  { key: 'apg', label: 'APG', format: (v) => Number(v).toFixed(1) },
  { key: 'spg', label: 'SPG', format: (v) => Number(v).toFixed(1) },
  { key: 'bpg', label: 'BPG', format: (v) => Number(v).toFixed(1) },
  { key: 'fg_pct', label: 'FG%', format: (v) => Number(v).toFixed(1) },
  { key: 'three_pct', label: '3P%', format: (v) => Number(v).toFixed(1) },
  { key: 'ft_pct', label: 'FT%', format: (v) => Number(v).toFixed(1) },
  { key: 'tov', label: 'TOV', format: (v) => Number(v).toFixed(1) },
];

export default function TeamTable({ teams }: TeamTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('wins');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const numericKeys = new Set(['wins','losses','ppg','rpg','apg','spg','bpg','fg_pct','three_pct','ft_pct','tov']);

  const sorted = [...teams].sort((a, b) => {
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

  return (
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
          {sorted.map((team, i) => (
            <tr
              key={team.id}
              className={`border-b border-[#2a2d3a] transition-colors hover:bg-[#2a2d3a] ${
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
                  {col.format && team[col.key] != null
                    ? col.format(team[col.key] as number)
                    : String(team[col.key] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-[#6b7280]">
                No teams found
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
