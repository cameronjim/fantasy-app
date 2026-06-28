import { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getGames, getLiveGames } from '../api/client';
import type { Game } from '../types';

// persists across remounts so navigating back is instant
let gamesCache: Game[] = [];
let cacheFetchedAt = 0;

function periodLabel(period: number): string {
  if (period <= 4) return `Q${period}`;
  return `OT${period - 4 > 1 ? period - 4 : ''}`;
}

export const ScoreboardStrip = () => {
  const [games, setGames] = useState<Game[]>(gamesCache);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secAgo, setSecAgo] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchGames = useCallback(async (): Promise<void> => {
    try {
      // Step 1: Show DB data immediately — always fast (~100ms)
      const dbGames = await getGames();
      setGames(dbGames);
      setLastUpdated(new Date());
      setSecAgo(0);
      gamesCache = dbGames;
      cacheFetchedAt = Date.now();

      // Step 2: Overlay live scores silently in the background.
      // Server caches ESPN response for 3 min so this is usually fast.
      // Merge by date+team so old NBA game IDs and new ESPN IDs don't create duplicates.
      getLiveGames().then((liveGames) => {
        if (!liveGames.length) return;
        // Deduplicate by both ID and matchup so stale DB records with wrong dates
        // don't create ghost duplicates alongside the correct live record.
        const liveIds = new Set(liveGames.map((g) => g.nba_game_id ?? g.id));
        const liveMatchup = (g: Game) =>
          `${(g.home_team ?? '').toLowerCase()}||${(g.away_team ?? '').toLowerCase()}`;
        const liveMatchups = new Set(liveGames.map(liveMatchup));
        setGames((prev) => {
          const merged = [
            ...liveGames,
            ...prev.filter((g) =>
              !liveIds.has(g.nba_game_id ?? g.id) && !liveMatchups.has(liveMatchup(g))
            ),
          ];
          gamesCache = merged;
          return merged;
        });
      }).catch(() => { /* live overlay failed — DB data already showing */ });
    } catch {
      setGames([]);
    }
  }, []);

  useEffect(() => {
    // skip fetch if cache is fresh (< 2 min old, matching server-side cache TTL)
    if (Date.now() - cacheFetchedAt > 2 * 60_000) {
      fetchGames();
    }
    const pollInterval = setInterval(fetchGames, 2 * 60_000);
    timerRef.current = setInterval(() => setSecAgo((s) => s + 1), 1000);
    return () => {
      clearInterval(pollInterval);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchGames]);

  const scroll = (direction: 'left' | 'right'): void => {
    const container = document.getElementById('scoreboard-scroll');
    if (!container) return;
    container.scrollBy({ left: direction === 'left' ? -280 : 280, behavior: 'smooth' });
  };

  const formatDate = (dateStr: string): string => {
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
      <div className="bg-base-200 border-b border-base-300 py-3 px-4 flex items-center justify-center">
        <p className="text-sm opacity-40">No games available</p>
      </div>
    );
  }

  return (
    <div className="bg-base-200 border-b border-base-300 relative">
      <button
        onClick={() => scroll('left')}
        className="btn btn-ghost btn-xs btn-circle absolute left-1 top-1/2 -translate-y-1/2 z-10"
      >
        <ChevronLeft size={16} />
      </button>

      <div
        id="scoreboard-scroll"
        className="flex gap-3 overflow-x-auto py-3 px-10 no-scrollbar"
      >
        {sortedDates.map((date) => (
          <div key={date} className="flex items-center gap-3 flex-shrink-0">
            <div className="flex-shrink-0 text-center px-2">
              <div className="text-[10px] font-bold opacity-40 uppercase tracking-wider">{formatDate(date)}</div>
              <div className="text-[10px] opacity-25">{date}</div>
            </div>

            {grouped[date].map((game) => {
              const isLive = game.status.toLowerCase() === 'in progress';
              const isFinal = game.status.toLowerCase() === 'final';
              const homeWon = isFinal && game.home_score != null && game.away_score != null && game.home_score > game.away_score;
              const awayWon = isFinal && game.home_score != null && game.away_score != null && game.away_score > game.home_score;

              return (
                <div
                  key={game.id}
                  className={`card card-compact bg-base-300 flex-shrink-0 min-w-[210px] ${isLive ? 'outline outline-1 outline-success/40' : ''}`}
                >
                  <div className="card-body gap-1.5">
                    <div className="flex items-center gap-2">
                      {isLive ? (
                        <span className="badge badge-success badge-sm gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                          {game.period
                            ? `${periodLabel(game.period)}${game.game_clock ? ` ${game.game_clock}` : ''}`
                            : 'LIVE'}
                        </span>
                      ) : (
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isFinal ? 'opacity-40' : 'text-info'}`}>
                          {isFinal ? 'FINAL' : game.status.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between gap-4">
                        <span className={`text-sm ${awayWon ? 'font-bold' : 'opacity-60'}`}>{game.away_team}</span>
                        <span className={`text-sm tabular-nums ${awayWon ? 'font-bold' : ''}`}>{game.away_score ?? '-'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span className={`text-sm ${homeWon ? 'font-bold' : 'opacity-60'}`}>{game.home_team}</span>
                        <span className={`text-sm tabular-nums ${homeWon ? 'font-bold' : ''}`}>{game.home_score ?? '-'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="w-px h-12 bg-base-300 flex-shrink-0" />
          </div>
        ))}
      </div>

      <button
        onClick={() => scroll('right')}
        className="btn btn-ghost btn-xs btn-circle absolute right-1 top-1/2 -translate-y-1/2 z-10"
      >
        <ChevronRight size={16} />
      </button>

      {hasLive && lastUpdated && (
        <div className="absolute right-10 top-1 text-[10px] opacity-25">
          updated {secAgo < 5 ? 'just now' : `${secAgo}s ago`}
        </div>
      )}
    </div>
  );
};
