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
    return sum + (Number(player[key as keyof Player]) || 0) * (weight ?? 0);
  }, 0);
}

export default function CompareModal({ players, onClose }: CompareModalProps) {
  if (players.length < 2) return null;

  const scores = players.map(fantasyScore);
  const cols = players.length;

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-3xl max-h-[90vh] flex flex-col p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-base-300 flex-shrink-0">
          <h3 className="font-semibold text-base">Player Comparison</h3>
          <button className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="overflow-y-auto">
          {/* Player headers */}
          <div className="grid border-b border-base-300" style={{ gridTemplateColumns: `180px repeat(${cols}, 1fr)` }}>
            <div className="px-4 py-3" />
            {players.map((p) => (
              <div key={p.id} className="px-4 py-3 flex flex-col items-center gap-2 border-l border-base-300">
                <div className="avatar">
                  <div className="w-12 rounded-full ring ring-base-300">
                    <img
                      src={p.headshot_url || FALLBACK_SVG}
                      alt={p.name}
                      onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_SVG; }}
                    />
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-semibold leading-tight">{p.name}</div>
                  <div className="text-xs opacity-50 mt-0.5">{p.position} · {p.team}</div>
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
                className={`grid border-b border-base-300 ${rowIdx % 2 === 0 ? 'bg-base-200' : 'bg-base-100'}`}
                style={{ gridTemplateColumns: `180px repeat(${cols}, 1fr)` }}
              >
                <div className="px-4 py-3 flex items-center">
                  <span className="text-xs font-medium opacity-60">{stat.label}</span>
                </div>
                {players.map((p, pIdx) => {
                  const val = values[pIdx];
                  const isBest = val === best;
                  return (
                    <div
                      key={p.id}
                      className={`px-4 py-3 flex items-center justify-center border-l border-base-300 ${isBest ? 'text-success font-bold' : ''}`}
                    >
                      <span className="text-sm tabular-nums">{stat.format(val)}</span>
                      {isBest && players.length > 1 && (
                        <span className="ml-1 text-[10px] text-success opacity-70">▲</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Fantasy Score */}
          <div className="grid bg-base-200" style={{ gridTemplateColumns: `180px repeat(${cols}, 1fr)` }}>
            <div className="px-4 py-3.5 flex items-center">
              <span className="text-xs font-bold text-primary uppercase tracking-wider">Fantasy Score</span>
            </div>
            {players.map((p, pIdx) => {
              const score = scores[pIdx];
              const isBest = score === Math.max(...scores);
              return (
                <div
                  key={p.id}
                  className={`px-4 py-3.5 flex items-center justify-center border-l border-base-300 ${isBest ? 'text-primary font-bold' : ''}`}
                >
                  <span className="text-sm tabular-nums">{score.toFixed(1)}</span>
                  {isBest && <span className="ml-1 text-[10px] opacity-70">★</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
