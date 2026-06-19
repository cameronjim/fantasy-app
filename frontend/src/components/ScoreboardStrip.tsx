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
  // tracks the day we've already auto-scrolled to "today" for, so the
  // background poll and live-score overlay (both of which update `games`)
  // don't keep yanking the strip back to today while the user is manually
  // scrolling through past or upcoming games.
  const autoScrolledForDay = useRef<string | null>(null);

  const fetchGames = useCallback(async (): Promise<void> => {
    try {
      // Step 1: Show DB data immediately — always fast (~100ms)
      const dbGames = await getGames();
      setGames(dbGames);
      gamesCache = dbGames;
      cacheFetchedAt = Date.now();

      // Step 2: Overlay live scores silently in the background.
      // Server caches ESPN response for 3 min so this is usually fast.
      // Merge by date+team so old NBA game IDs and new ESPN IDs don't create duplicates.
      getLiveGames().then((liveGames) => {
        if (!liveGames.length) return;
        // Deduplicate by ID and by (date + matchup). The date matters: in a playoff
        // series the same two teams play multiple games, so a live OKC@SAS today must
        // not filter out a scheduled OKC@SAS two days from now.
        const liveIds = new Set(liveGames.map((g) => g.nba_game_id ?? g.id));
        const liveMatchup = (g: Game) =>
          `${g.game_date}||${(g.home_team ?? '').toLowerCase()}||${(g.away_team ?? '').toLowerCase()}`;
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
    return () => clearInterval(pollInterval);
  }, [fetchGames]);

  const scroll = (direction: 'left' | 'right'): void => {
    const container = document.getElementById('scoreboard-scroll');
    if (!container) return;
    container.scrollBy({ left: direction === 'left' ? -280 : 280, behavior: 'smooth' });
  };

  // Today's date as YYYY-MM-DD in the user's local TZ. Computed at render time
  // (and inside an effect below) so it stays correct across midnight.
  const todayIso = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

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

  // auto-scroll the strip so "today" lands in the SECOND slot — one recent
  // past day visible to its left, today next to it. this runs only ONCE per
  // day: re-running on every `games` update would fight the user, snapping
  // them back each time the 2-min poll or the live overlay refreshes the data
  // while they scroll. the ref re-arms when the date rolls over.
  useEffect(() => {
    if (games.length === 0) return;
    if (autoScrolledForDay.current === todayIso) return;
    // double rAF: wait until the strip has actually painted (card widths
    // settled) before measuring, otherwise the target is computed against a
    // half-laid-out row and lands in the wrong place — the failure we saw in
    // prod where today ended up on the far right.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const container = document.getElementById('scoreboard-scroll');
        if (!container) return;
        const groups = Array.from(
          container.querySelectorAll<HTMLElement>('[data-date]')
        );
        const todayIdx = groups.findIndex((el) => el.dataset.date === todayIso);
        if (todayIdx === -1) return;
        // anchor on the group just before today so today sits in the second
        // slot. if today is the first group (no past games), it leads.
        const anchor = groups[Math.max(0, todayIdx - 1)];
        // measure live rects so container padding / offset-parent quirks don't
        // skew the math. delta = how far the anchor currently sits from the
        // container's left edge; scrolling by it brings the anchor flush-left.
        const delta =
          anchor.getBoundingClientRect().left - container.getBoundingClientRect().left;
        // small gap so the anchor clears the left scroll button.
        container.scrollLeft += delta - 36;
        autoScrolledForDay.current = todayIso;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [games, todayIso]);

  const grouped = games.reduce<Record<string, Game[]>>((acc, g) => {
    const date = g.game_date?.split('T')[0] || 'Unknown';
    if (!acc[date]) acc[date] = [];
    acc[date].push(g);
    return acc;
  }, {});

  // always include today in the scoreboard so the auto-scroll has a stable
  // anchor. without this, an off-season day (or any day where the scraper
  // hasn't picked up new games) leaves the user looking at the oldest date
  // with no signal that "today" is real and just has no games.
  if (!grouped[todayIso]) grouped[todayIso] = [];

  const sortedDates = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

  // when there are few groups after today (e.g. the season/series is over and
  // no upcoming games are loaded), today would be the last group and the
  // browser couldn't scroll it off the right edge into the second slot. a
  // trailing spacer adds the scroll room so the auto-scroll can still place
  // today second. when plenty of future groups exist it's unnecessary, so we
  // skip it to avoid blank space past the last game.
  const futureGroupCount = sortedDates.filter((d) => d > todayIso).length;
  const needsTrailingRoom = futureGroupCount < 5;

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
          <div key={date} data-date={date} className="flex items-center gap-3 flex-shrink-0">
            <div className="flex-shrink-0 text-center px-2">
              <div className="text-[10px] font-bold opacity-40 uppercase tracking-wider">{formatDate(date)}</div>
              <div className="text-[10px] opacity-25">{date}</div>
            </div>

            {grouped[date].length === 0 && (
              <div className="card card-compact bg-base-300/50 flex-shrink-0 min-w-[200px] border border-dashed border-base-300">
                <div className="card-body items-center justify-center text-center">
                  <p className="text-xs opacity-50">No games scheduled</p>
                </div>
              </div>
            )}

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

        {/* trailing scroll room so today can sit in the second slot even when
            it's the latest group with nothing after it. */}
        {needsTrailingRoom && <div aria-hidden className="flex-shrink-0 w-screen" />}
      </div>

      <button
        onClick={() => scroll('right')}
        className="btn btn-ghost btn-xs btn-circle absolute right-1 top-1/2 -translate-y-1/2 z-10"
      >
        <ChevronRight size={16} />
      </button>

    </div>
  );
};
