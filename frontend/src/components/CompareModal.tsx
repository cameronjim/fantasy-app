import { X } from 'lucide-react';
import type { Player } from '../types';

interface CompareModalProps {
  players: Player[];
  onClose: () => void;
}

const STATS: { key: keyof Player; label: string; format: (v: number) => string; higherIsBetter: boolean }[] = [
  { key: 'ppg', label: 'Points (PPG)', format: (v) => Number(v).toFixed(1), higherIsBetter: true },
  { key: 'rpg', label: 'Rebounds (RPG)', format: (v) => Number(v).toFixed(1), higherIsBetter: true },
  { key: 'apg', label: 'Assists (APG)', format: (v) => Number(v).toFixed(1), higherIsBetter: true },
  { key: 'spg', label: 'Steals (SPG)', format: (v) => Number(v).toFixed(1), higherIsBetter: true },
  { key: 'bpg', label: 'Blocks (BPG)', format: (v) => Number(v).toFixed(1), higherIsBetter: true },
  { key: 'fg_pct', label: 'FG%', format: (v) => Number(v).toFixed(1) + '%', higherIsBetter: true },
  { key: 'ft_pct', label: 'FT%', format: (v) => Number(v).toFixed(1) + '%', higherIsBetter: true },
  { key: 'three_pm', label: '3-Pointers Made', format: (v) => Number(v).toFixed(1), higherIsBetter: true },
  { key: 'tov', label: 'Turnovers (TOV)', format: (v) => Number(v).toFixed(1), higherIsBetter: false },
];

const FANTASY_WEIGHTS: Partial<Record<keyof Player, number>> = {
  ppg: 1, rpg: 1, apg: 1, spg: 2, bpg: 2, fg_pct: 0.5, ft_pct: 0.5, three_pm: 1.5, tov: -1,
};

const FALLBACK_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23252836'/%3E%3Ccircle cx='20' cy='15' r='7' fill='%234b5563'/%3E%3Cellipse cx='20' cy='35' rx='12' ry='8' fill='%234b5563'/%3E%3C/svg%3E";

function fantasyScore(player: Player): number {
  return Object.entries(FANTASY_WEIGHTS).reduce((sum, [key, weight]) => {
    const val = Number(player[key as keyof Player]) || 0;
    return sum + val * (weight ?? 0);
  }, 0);
}

export default function CompareModal({ players, onClose }: CompareModalProps) {
  if (players.length < 2) return null;

  const scores = players.map(fantasyScore);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] w-full max-w-3xl shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2d3a] flex-shrink-0">
          <h2 className="text-base font-semibold text-white">Player Comparison</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[#252836] transition-colors text-[#9ca3af] hover:text-white cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto">
          {/* Player headers */}
          <div className="grid border-b border-[#2a2d3a]" style={{ gridTemplateColumns: `180px repeat(${players.length}, 1fr)` }}>
            <div className="px-4 py-3" />
            {players.map((p) => (
              <div key={p.id} className="px-4 py-3 flex flex-col items-center gap-2 border-l border-[#2a2d3a]">
                <img
                  src={p.headshot_url || FALLBACK_SVG}
                  alt={p.name}
                  className="w-12 h-12 rounded-full object-cover object-top bg-[#252836] border-2 border-[#2a2d3a]"
                  onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_SVG; }}
                />
                <div className="text-center">
                  <div className="text-sm font-semibold text-white leading-tight">{p.name}</div>
                  <div className="text-xs text-[#6b7280] mt-0.5">{p.position} · {p.team}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Stat rows */}
          {STATS.map((stat, rowIdx) => {
            const values = players.map((p) => Number(p[stat.key]) || 0);
            const best = stat.higherIsBetter ? Math.max(...values) : Math.min(...values);
            return (
              <div
                key={stat.key}
                className={`grid border-b border-[#2a2d3a] ${rowIdx % 2 === 0 ? 'bg-[#0f1117]' : 'bg-[#151822]'}`}
                style={{ gridTemplateColumns: `180px repeat(${players.length}, 1fr)` }}
              >
                <div className="px-4 py-3 flex items-center">
                  <span className="text-xs font-medium text-[#9ca3af]">{stat.label}</span>
                </div>
                {players.map((p, pIdx) => {
                  const val = values[pIdx];
                  const isBest = val === best;
                  return (
                    <div
                      key={p.id}
                      className={`px-4 py-3 flex items-center justify-center border-l border-[#2a2d3a] ${
                        isBest ? 'text-[#22c55e] font-bold' : 'text-[#d1d5db]'
                      }`}
                    >
                      <span className="text-sm tabular-nums">{stat.format(val)}</span>
                      {isBest && players.length > 1 && (
                        <span className="ml-1.5 text-[10px] text-[#22c55e] opacity-70">▲</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Fantasy Score row */}
          <div
            className="grid bg-[#1a1d29]"
            style={{ gridTemplateColumns: `180px repeat(${players.length}, 1fr)` }}
          >
            <div className="px-4 py-3.5 flex items-center">
              <span className="text-xs font-bold text-[#3b82f6] uppercase tracking-wider">Fantasy Score</span>
            </div>
            {players.map((p, pIdx) => {
              const score = scores[pIdx];
              const bestScore = Math.max(...scores);
              const isBest = score === bestScore;
              return (
                <div
                  key={p.id}
                  className={`px-4 py-3.5 flex items-center justify-center border-l border-[#2a2d3a] ${
                    isBest ? 'text-[#3b82f6] font-bold' : 'text-[#d1d5db]'
                  }`}
                >
                  <span className="text-sm tabular-nums">{score.toFixed(1)}</span>
                  {isBest && (
                    <span className="ml-1.5 text-[10px] text-[#3b82f6] opacity-70">★</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
