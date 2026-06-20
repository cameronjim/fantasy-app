import { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getGames, getLiveGames } from '../api/client';
import type { Game } from '../types';

function periodLabel(period: number): string {
  if (period <= 4) return `Q${period}`;
  return `OT${period - 4 > 1 ? period - 4 : ''}`;
}

export default function ScoreboardStrip() {
  const [games, setGames] = useState<Game[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secAgo, setSecAgo] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchGames = useCallback(async () => {
    try {
      const [liveGames, allGames] = await Promise.all([
        getLiveGames().catch(() => [] as Game[]),
        getGames().catch(() => [] as Game[]),
      ]);

      const liveIds = new Set(liveGames.map((g) => g.nba_game_id ?? g.id));
      const merged = [
        ...liveGames,
        ...allGames.filter((g) => !liveIds.has(g.nba_game_id ?? g.id)),
      ];
      setGames(merged);
      setLastUpdated(new Date());
      setSecAgo(0);
    } catch {
      setGames([]);
    }
  }, []);

  useEffect(() => {
    fetchGames();
    const pollInterval = setInterval(fetchGames, 30_000);
    timerRef.current = setInterval(() => setSecAgo((s) => s + 1), 1000);
    return () => {
      clearInterval(pollInterval);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchGames]);

  const scroll = (direction: 'left' | 'right') => {
    const container = document.getElementById('scoreboard-scroll');
    if (!container) return;
    container.scrollBy({ left: direction === 'left' ? -280 : 280, behavior: 'smooth' });
  };

  const getStatusColor = (status: string) => {
    const s = status.toLowerCase();
    if (s === 'in progress') return 'text-[#22c55e]';
    if (s === 'final') return 'text-[#9ca3af]';
    return 'text-[#3b82f6]';
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const diffDays = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === -1) return 'Yesterday';
    if (diffDays === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const hasLive = games.some((g) => g.status.toLowerCase() === 'in progress');

  const grouped = games.reduce<Record<string, Game[]>>((acc, g) => {
    const date = g.game_date?.split('T')[0] || 'Unknown';
    if (!acc[date]) acc[date] = [];
    acc[date].push(g);
    return acc;
  }, {});

  const sortedDates = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

  if (games.length === 0) {
    return (
      <div className="bg-[#1a1d29] border-b border-[#2a2d3a] py-3 px-4 flex items-center justify-center gap-2">
        <p className="text-[#6b7280] text-sm">No games available</p>
      </div>
    );
  }

  return (
    <div className="bg-[#1a1d29] border-b border-[#2a2d3a] relative">
      <button
        onClick={() => scroll('left')}
        className="absolute left-0 top-0 bottom-0 z-10 px-2 bg-gradient-to-r from-[#1a1d29] to-transparent hover:from-[#252836] transition-colors cursor-pointer"
      >
        <ChevronLeft size={18} className="text-[#9ca3af]" />
      </button>

      <div
        id="scoreboard-scroll"
        className="flex gap-3 overflow-x-auto py-3 px-10 no-scrollbar"
        style={{ scrollbarWidth: 'none' }}
      >
        {sortedDates.map((date) => (
          <div key={date} className="flex items-center gap-3 flex-shrink-0">
            {/* Date label */}
            <div className="flex-shrink-0 text-center px-2">
              <div className="text-[10px] font-bold text-[#6b7280] uppercase tracking-wider">
                {formatDate(date)}
              </div>
              <div className="text-[10px] text-[#4b5563]">{date}</div>
            </div>

            {/* Games */}
            {grouped[date].map((game) => {
              const isLive = game.status.toLowerCase() === 'in progress';
              const isFinal = game.status.toLowerCase() === 'final';
              const homeWon = isFinal && game.home_score != null && game.away_score != null && game.home_score > game.away_score;
              const awayWon = isFinal && game.home_score != null && game.away_score != null && game.away_score > game.home_score;

              return (
                <div
                  key={game.id}
                  className={`flex-shrink-0 bg-[#252836] rounded-lg px-3.5 py-2.5 min-w-[210px] border transition-colors ${
                    isLive ? 'border-[#22c55e]/30' : 'border-[#2a2d3a] hover:border-[#3b3f51]'
                  }`}
                >
                  {/* Status row */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      {isLive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse flex-shrink-0" />
                      )}
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${getStatusColor(game.status)}`}>
                        {isLive
                          ? game.period
                            ? `${periodLabel(game.period)}${game.game_clock ? ` ${game.game_clock}` : ''}`
                            : 'LIVE'
                          : isFinal
                          ? 'FINAL'
                          : game.status.toUpperCase()}
                      </span>
                    </div>
                  </div>

                  {/* Scores */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-medium ${awayWon ? 'text-white' : 'text-[#9ca3af]'}`}>
                        {game.away_team}
                      </span>
                      <span className={`text-sm font-bold tabular-nums ${awayWon ? 'text-white' : 'text-[#d1d5db]'}`}>
                        {game.away_score ?? '-'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-medium ${homeWon ? 'text-white' : 'text-[#9ca3af]'}`}>
                        {game.home_team}
                      </span>
                      <span className={`text-sm font-bold tabular-nums ${homeWon ? 'text-white' : 'text-[#d1d5db]'}`}>
                        {game.home_score ?? '-'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Separator */}
            <div className="w-px h-12 bg-[#2a2d3a] flex-shrink-0" />
          </div>
        ))}
      </div>

      <button
        onClick={() => scroll('right')}
        className="absolute right-0 top-0 bottom-0 z-10 px-2 bg-gradient-to-l from-[#1a1d29] to-transparent hover:from-[#252836] transition-colors cursor-pointer"
      >
        <ChevronRight size={18} className="text-[#9ca3af]" />
      </button>

      {/* Last updated ticker — only show when there are live games */}
      {hasLive && lastUpdated && (
        <div className="absolute right-10 top-1 text-[10px] text-[#4b5563]">
          updated {secAgo < 5 ? 'just now' : `${secAgo}s ago`}
        </div>
      )}
    </div>
  );
}
