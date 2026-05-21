import type { Player } from '../types';

interface PlayerCardProps {
  player: Player;
  actionLabel: string;
  onAction: () => void;
  actionColor?: 'blue' | 'red';
}

export const PlayerCard = ({
  player,
  actionLabel,
  onAction,
  actionColor = 'blue',
}: PlayerCardProps) => {
  const getInjuryBadge = (): JSX.Element | null => {
    if (!player.injury_status) return null;
    const colors: Record<string, string> = {
      Out: 'bg-[#ef4444]/20 text-[#ef4444]',
      Day_To_Day: 'bg-[#f59e0b]/20 text-[#f59e0b]',
      'Day-To-Day': 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Questionable: 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Probable: 'bg-[#22c55e]/20 text-[#22c55e]',
    };
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${colors[player.injury_status] || 'bg-[#ef4444]/20 text-[#ef4444]'}`}>
        {player.injury_status.replace(/_/g, ' ')}
      </span>
    );
  };

  const btnColors =
    actionColor === 'red'
      ? 'bg-[#ef4444]/10 text-[#ef4444] hover:bg-[#ef4444]/20'
      : 'bg-[#3b82f6]/10 text-[#3b82f6] hover:bg-[#3b82f6]/20';

  return (
    <div className="bg-[#1a1d29] border border-[#2a2d3a] rounded-lg p-3 hover:border-[#3b3f51] transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white truncate">{player.name}</span>
            {getInjuryBadge()}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-[#9ca3af]">{player.team}</span>
            <span className="text-[#3b3f51]">|</span>
            <span className="text-xs text-[#9ca3af]">{player.position}</span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <div className="text-center">
              <div className="text-xs font-bold text-white">{Number(player.points_per_game).toFixed(1)}</div>
              <div className="text-[10px] text-[#6b7280]">PPG</div>
            </div>
            <div className="text-center">
              <div className="text-xs font-bold text-white">{Number(player.rebounds_per_game).toFixed(1)}</div>
              <div className="text-[10px] text-[#6b7280]">RPG</div>
            </div>
            <div className="text-center">
              <div className="text-xs font-bold text-white">{Number(player.assists_per_game).toFixed(1)}</div>
              <div className="text-[10px] text-[#6b7280]">APG</div>
            </div>
            <div className="text-center">
              <div className="text-xs font-bold text-white">{Number(player.field_goal_percentage).toFixed(1)}</div>
              <div className="text-[10px] text-[#6b7280]">FG%</div>
            </div>
          </div>
        </div>
        <button
          onClick={onAction}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex-shrink-0 cursor-pointer ${btnColors}`}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
};
