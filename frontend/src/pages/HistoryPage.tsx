import { useState } from 'react';
import { History, Search } from 'lucide-react';
import { SeasonPlayerTable } from '../components/SeasonPlayerTable';
import { PlayerCareerModal } from '../components/PlayerCareerModal';
import { getHistoryPlayers, getHistorySeasons, type HistoryPlayersResponse } from '../api/client';
import { useCachedResource } from '../hooks/useCachedResource';
import { CACHE_KEYS, historyPlayersKey } from '../api/resourceCache';
import type { PlayerSeasonRow } from '../types';

// the api caps a page at 500 rows, which covers every player in a season, so
// one request per season is enough and the search box can filter in memory.
// a season loads in one request and the search box filters in memory, so this
// has to clear the largest season outright or the tail is unreachable. modern
// seasons run past 500 (2021-22 had 605 players once two-ways are counted);
// the api ceiling for this route is 1000.
const SEASON_ROW_LIMIT = 1000;

export const HistoryPage = (): JSX.Element => {
  const [selectedSeason, setSelectedSeason] = useState('');
  const [search, setSearch] = useState('');
  // the clicked row, which already carries the id the career endpoint wants.
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerSeasonRow | null>(null);

  // cached copies render instantly on tab return; a silent background refetch
  // keeps them current, same as the Stats page.
  const {
    data: seasons,
    loading: loadingSeasons,
    error: seasonsError,
    reload: reloadSeasons,
  } = useCachedResource<string[]>(CACHE_KEYS.historySeasons, getHistorySeasons, {
    errorMessage: 'Failed to load historical seasons',
  });

  const seasonList = seasons ?? [];
  // the api returns seasons newest first, so entry 0 is the sensible default
  // until the user picks one.
  const activeSeason = selectedSeason || seasonList[0] || '';

  const {
    data: seasonData,
    loading: loadingRows,
    error: rowsError,
    reload: reloadRows,
  } = useCachedResource<HistoryPlayersResponse>(
    historyPlayersKey(activeSeason),
    () => getHistoryPlayers({ season: activeSeason, limit: SEASON_ROW_LIMIT }),
    { enabled: !!activeSeason, errorMessage: 'Failed to load season stats' }
  );

  const rows = seasonData?.players ?? [];
  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((row) => (row.player_name ?? '').toLowerCase().includes(term))
    : rows;
  const total = seasonData?.total ?? 0;
  const truncated = total > rows.length;

  const renderBody = (): JSX.Element => {
    if (loadingRows) {
      return (
        <div className="flex items-center justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      );
    }

    if (rowsError) {
      return (
        <div className="card bg-base-200">
          <div className="card-body flex flex-col items-center py-12 gap-4">
            <p className="text-error text-sm">{rowsError}</p>
            <button onClick={() => void reloadRows()} className="btn btn-primary btn-sm">
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return <SeasonPlayerTable rows={filtered} onSelect={setSelectedPlayer} />;
  };

  return (
    <div className="pb-20">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="flex items-center gap-2 mb-1">
          <History size={20} className="opacity-60" />
          <h1 className="text-xl font-bold">Season History</h1>
        </div>
        <p className="text-sm opacity-50 mb-5">
          Per-game averages for every player, season by season. Click a player for his other
          seasons.
        </p>

        {loadingSeasons ? (
          <div className="flex items-center justify-center py-20">
            <span className="loading loading-spinner loading-lg" />
          </div>
        ) : seasonsError ? (
          <div className="card bg-base-200">
            <div className="card-body flex flex-col items-center py-12 gap-4">
              <p className="text-error text-sm">{seasonsError}</p>
              <button onClick={() => void reloadSeasons()} className="btn btn-primary btn-sm">
                Try Again
              </button>
            </div>
          </div>
        ) : seasonList.length === 0 ? (
          // the historical backfill is a manual one-time job, so an empty
          // season list is the expected state until it has been run.
          <div className="card bg-base-200">
            <div className="card-body items-center text-center py-12 gap-2">
              <History size={32} className="opacity-30" />
              <p className="font-semibold">No historical data available yet</p>
              <p className="text-sm opacity-60 max-w-md">
                Season-by-season stats show up here once historical seasons have been
                imported. Current-season stats are on the Stats tab in the meantime.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <select
                value={activeSeason}
                onChange={(e) => setSelectedSeason(e.target.value)}
                className="select select-bordered select-sm w-[140px]"
                aria-label="Season"
              >
                {seasonList.map((season) => (
                  <option key={season} value={season}>{season}</option>
                ))}
              </select>

              <label className="input input-bordered input-sm flex items-center gap-2 flex-1 min-w-[200px] max-w-[360px]">
                <Search size={14} className="opacity-50" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search players..."
                  aria-label="Search players"
                  className="grow"
                />
              </label>

              {truncated && (
                <span className="text-xs opacity-40">
                  showing the top {rows.length} of {total}
                </span>
              )}
            </div>

            {renderBody()}
          </>
        )}
      </div>

      {selectedPlayer && (
        <PlayerCareerModal
          playerName={selectedPlayer.player_name}
          nbaPlayerId={selectedPlayer.nba_player_id}
          onClose={() => setSelectedPlayer(null)}
        />
      )}
    </div>
  );
};
