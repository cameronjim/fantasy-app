import { X } from 'lucide-react';
import type { Player } from '../types';

interface PlayerModalProps {
  player: Player | null;
  onClose: () => void;
}

export default function PlayerModal({ player, onClose }: PlayerModalProps) {
  if (!player) return null;

  const getInjuryColor = (status: string) => {
    switch (status) {
      case 'Out':
        return 'bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/30';
      case 'Day_To_Day':
      case 'Day-To-Day':
      case 'Questionable':
        return 'bg-[#f59e0b]/20 text-[#f59e0b] border-[#f59e0b]/30';
      case 'Probable':
        return 'bg-[#22c55e]/20 text-[#22c55e] border-[#22c55e]/30';
      default:
        return 'bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/30';
    }
  };

  const n = (v: unknown) => Number(v) || 0;

  const statGroups = [
    {
      label: 'Scoring',
      stats: [
        { label: 'PPG', value: n(player.ppg).toFixed(1) },
        { label: 'FG%', value: n(player.fg_pct).toFixed(1) + '%' },
        { label: '3P%', value: n(player.three_pct).toFixed(1) + '%' },
        { label: 'FT%', value: n(player.ft_pct).toFixed(1) + '%' },
      ],
    },
    {
      label: 'Rebounds & Assists',
      stats: [
        { label: 'RPG', value: n(player.rpg).toFixed(1) },
        { label: 'APG', value: n(player.apg).toFixed(1) },
      ],
    },
    {
      label: 'Defense',
      stats: [
        { label: 'SPG', value: n(player.spg).toFixed(1) },
        { label: 'BPG', value: n(player.bpg).toFixed(1) },
      ],
    },
    {
      label: 'Other',
      stats: [
        { label: 'TOV', value: n(player.tov).toFixed(1) },
        { label: 'MIN', value: n(player.mpg).toFixed(1) },
        { label: 'GP', value: String(player.gp) },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] w-full max-w-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[#2a2d3a]">
          <div>
            <h2 className="text-2xl font-bold text-white">{player.name}</h2>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-[#9ca3af] text-sm">{player.team}</span>
              <span className="text-[#6b7280]">|</span>
              <span className="text-[#9ca3af] text-sm">{player.position}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[#252836] transition-colors text-[#9ca3af] hover:text-white cursor-pointer"
          >
            <X size={20} />
          </button>
        </div>

        {/* Injury Status */}
        {player.injury_status && (
          <div className={`mx-5 mt-4 px-3 py-2 rounded-lg border ${getInjuryColor(player.injury_status)}`}>
            <span className="text-xs font-bold uppercase">
              {player.injury_status.replace(/_/g, ' ')}
            </span>
            {player.injury_detail && (
              <span className="text-xs ml-2 opacity-80">&mdash; {player.injury_detail}</span>
            )}
          </div>
        )}

        {/* Stats Grid */}
        <div className="p-5 space-y-4">
          {statGroups.map((group) => (
            <div key={group.label}>
              <h3 className="text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2">
                {group.label}
              </h3>
              <div className="grid grid-cols-4 gap-2">
                {group.stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="bg-[#252836] rounded-lg px-3 py-2.5 text-center"
                  >
                    <div className="text-lg font-bold text-white">{stat.value}</div>
                    <div className="text-[10px] text-[#9ca3af] uppercase tracking-wider mt-0.5">
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
