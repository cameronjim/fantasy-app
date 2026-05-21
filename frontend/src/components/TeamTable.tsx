import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { Team } from '../types';

interface TeamTableProps {
  teams: Team[];
}

type SortKey = keyof Team;

const columns: { key: SortKey; label: string; format?: (v: number) => string }[] = [
  { key: 'name', label: 'Team' },
  { key: 'conference', label: 'Conf' },
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
  { key: 'off_rating', label: 'OFF RTG', format: (v) => Number(v).toFixed(1) },
  { key: 'def_rating', label: 'DEF RTG', format: (v) => Number(v).toFixed(1) },
  { key: 'net_rating', label: 'NET RTG', format: (v) => Number(v).toFixed(1) },
];

export default function TeamTable({ teams }: TeamTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('wins');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'conference' ? 'asc' : 'desc');
    }
  };

  const numericKeys = new Set(['wins','losses','ppg','rpg','apg','spg','bpg','fg_pct','three_pct','ft_pct','tov','def_rating','off_rating','net_rating']);

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
    <div className="overflow-x-auto rounded-box border border-base-300">
      <table className="table table-zebra table-sm w-full">
        <thead>
          <tr>
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
          {sorted.map((team) => (
            <tr key={team.id} className="hover">
              {columns.map((col) => {
                if (col.key === 'conference') {
                  return (
                    <td key={col.key}>
                      {team.conference && (
                        <span className={`badge badge-sm ${team.conference === 'East' ? 'badge-info' : 'badge-warning'}`}>
                          {team.conference}
                        </span>
                      )}
                    </td>
                  );
                }
                if (col.key === 'net_rating') {
                  const val = Number(team.net_rating ?? 0);
                  return (
                    <td key={col.key} className={`font-medium ${val > 0 ? 'text-success' : val < 0 ? 'text-error' : ''}`}>
                      {val > 0 ? '+' : ''}{val.toFixed(1)}
                    </td>
                  );
                }
                return (
                  <td key={col.key} className={col.key === 'name' ? 'font-medium' : ''}>
                    {col.format && team[col.key] != null
                      ? col.format(team[col.key] as number)
                      : String(team[col.key] ?? '-')}
                  </td>
                );
              })}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center py-12 opacity-40">
                No teams found
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
