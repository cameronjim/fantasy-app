import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getGames, getLiveGames } from '../api/client';
import type { Game } from '../types';

export default function ScoreboardStrip() {
  const [games, setGames] = useState<Game[]>([]);

  const fetchGames = useCallback(async () => {
    try {
      // Fetch live scores for today + historical games in parallel
      const [liveGames, allGames] = await Promise.all([
        getLiveGames().catch(() => [] as Game[]),
        getGames().catch(() => [] as Game[]),
      ]);

      // Merge: live games take precedence over DB games for today
      const liveIds = new Set(liveGames.map((g) => g.nba_game_id ?? g.id));
      const merged = [
        ...liveGames,
        ...allGames.filter((g) => !liveIds.has(g.nba_game_id ?? g.id)),
      ];
      setGames(merged);
    } catch {
      setGames([]);
    }
  }, []);

  useEffect(() => {
    fetchGames();
    // Poll every 30 seconds for live score updates
    const interval = setInterval(fetchGames, 30_000);
    return () => clearInterval(interval);
  }, [fetchGames]);

  const scroll = (direction: 'left' | 'right') => {
    const container = document.getElementById('scoreboard-scroll');
    if (!container) return;
    const amount = direction === 'left' ? -280 : 280;
    container.scrollBy({ left: amount, behavior: 'smooth' });
  };

  const getStatusColor = (status: string) => {
    const s = status.toLowerCase();
    if (s === 'in progress' || s === 'live') return 'text-[#22c55e]';
    if (s === 'final') return 'text-[#9ca3af]';
    return 'text-[#3b82f6]';
  };

  const getStatusLabel = (status: string) => {
    const s = status.toLowerCase();
    if (s === 'in progress' || s === 'live') return 'LIVE';
    if (s === 'final') return 'FINAL';
    if (s === 'scheduled') return 'UPCOMING';
    return status.toUpperCase(); // show time like "7:00 PM ET"
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

  // Group games by date, sorted with today first, then future, then past
  const grouped = games.reduce<Record<string, Game[]>>((acc, g) => {
    const date = g.game_date?.split('T')[0] || 'Unknown';
    if (!acc[date]) acc[date] = [];
    acc[date].push(g);
    return acc;
  }, {});

  const sortedDates = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

  if (games.length === 0) {
    return (
      <div className="bg-[#1a1d29] border-b border-[#2a2d3a] py-3 px-4">
        <p className="text-[#6b7280] text-sm text-center">
          No games available
        </p>
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

            {/* Games for this date */}
            {grouped[date].map((game) => (
              <div
                key={game.id}
                className="flex-shrink-0 bg-[#252836] rounded-lg px-4 py-2.5 min-w-[220px] border border-[#2a2d3a] hover:border-[#3b3f51] transition-colors"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${getStatusColor(game.status)}`}>
                    {getStatusLabel(game.status)}
                  </span>
                  {game.status.toLowerCase() === 'in progress' && (
                    <span className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" />
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-[#e5e7eb]">{game.away_team}</span>
                    <span className="text-sm font-bold text-white tabular-nums">{game.away_score ?? '-'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[#e5e7eb]">{game.home_team}</span>
                    <span className="text-sm font-bold text-white tabular-nums">{game.home_score ?? '-'}</span>
                  </div>
                </div>
              </div>
            ))}

            {/* Separator between dates */}
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
    </div>
  );
}
