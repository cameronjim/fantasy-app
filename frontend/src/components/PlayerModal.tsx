import type { Player } from '../types';

interface PlayerModalProps {
  player: Player | null;
  onClose: () => void;
}

export default function PlayerModal({ player, onClose }: PlayerModalProps) {
  if (!player) return null;

  const injuryAlertClass = (status: string) => {
    if (status === 'Out') return 'alert alert-error';
    if (['Day-To-Day', 'Day_To_Day', 'Questionable'].includes(status)) return 'alert alert-warning';
    if (status === 'Probable') return 'alert alert-success';
    return 'alert alert-error';
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
    <div className="modal modal-open">
      <div className="modal-box max-w-lg">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-4">
            {player.headshot_url && (
              <div className="avatar">
                <div className="w-16 rounded-full ring ring-primary ring-offset-base-100 ring-offset-2">
                  <img
                    src={player.headshot_url}
                    alt={player.name}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              </div>
            )}
            <div>
              <h3 className="font-bold text-2xl">{player.name}</h3>
              <p className="text-sm opacity-60">{player.team} · {player.position}</p>
            </div>
          </div>
          <button className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>✕</button>
        </div>

        {player.injury_status && (
          <div className={`${injuryAlertClass(player.injury_status)} mb-4 py-2`}>
            <span className="text-xs font-bold uppercase">{player.injury_status.replace(/_/g, ' ')}</span>
            {player.injury_detail && (
              <span className="text-xs ml-2 opacity-80">— {player.injury_detail}</span>
            )}
          </div>
        )}

        {statGroups.map((group) => (
          <div key={group.label} className="mb-4">
            <p className="text-xs font-semibold opacity-40 uppercase tracking-wider mb-2">{group.label}</p>
            <div className="stats stats-horizontal shadow w-full border border-base-300">
              {group.stats.map((stat) => (
                <div key={stat.label} className="stat px-4 py-3">
                  <div className="stat-value text-lg">{stat.value}</div>
                  <div className="stat-title text-[10px] uppercase tracking-wider">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
