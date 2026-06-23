import { useEffect, useState } from 'react';
import { Search, Filter, GitCompare, X } from 'lucide-react';
import ScoreboardStrip from '../components/ScoreboardStrip';
import PlayerTable from '../components/PlayerTable';
import TeamTable from '../components/TeamTable';
import PlayerModal from '../components/PlayerModal';
import CompareModal from '../components/CompareModal';
import { getPlayers, getTeams } from '../api/client';
import type { Player, Team } from '../types';

const POSITIONS = ['All', 'PG', 'SG', 'SF', 'PF', 'C'];

export default function StatsPage() {
  const [view, setView] = useState<'players' | 'teams'>('players');
  const [players, setPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [posFilter, setPosFilter] = useState('All');
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [comparePlayers, setComparePlayers] = useState<Player[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [confFilter, setConfFilter] = useState<'All' | 'East' | 'West'>('All');

  useEffect(() => {
    setLoadingPlayers(true);
    getPlayers()
      .then(setPlayers)
      .catch(() => setPlayers([]))
      .finally(() => setLoadingPlayers(false));

    setLoadingTeams(true);
    getTeams()
      .then(setTeams)
      .catch(() => setTeams([]))
      .finally(() => setLoadingTeams(false));
  }, []);

  const teamNames = [...new Set(players.map((p) => p.team))].sort();

  const filteredPlayers = players.filter((p) => {
    const matchesSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
    const matchesTeam = !teamFilter || p.team === teamFilter;
    const matchesPos = posFilter === 'All' || p.position.split(',').includes(posFilter);
    return matchesSearch && matchesTeam && matchesPos;
  });

  const handleToggleCompare = (player: Player) => {
    setComparePlayers((prev) => {
      const exists = prev.find((p) => p.id === player.id);
      if (exists) return prev.filter((p) => p.id !== player.id);
      if (prev.length >= 3) return prev;
      return [...prev, player];
    });
  };

  return (
    <div className="pb-20">
      <ScoreboardStrip />

      <div className="max-w-[1400px] mx-auto px-4 py-6">
        {/* View Toggle */}
        <div className="flex items-center gap-4 mb-5">
          <div className="tabs tabs-boxed">
            <button
              onClick={() => setView('players')}
              className={`tab ${view === 'players' ? 'tab-active' : ''}`}
            >
              Players
            </button>
            <button
              onClick={() => setView('teams')}
              className={`tab ${view === 'teams' ? 'tab-active' : ''}`}
            >
              Teams
            </button>
          </div>

          {view === 'players' && (
            <span className="text-sm opacity-40">
              {filteredPlayers.length} player{filteredPlayers.length !== 1 ? 's' : ''}
            </span>
          )}

          {view === 'teams' && (
            <div className="join">
              {(['All', 'East', 'West'] as const).map((conf) => (
                <button
                  key={conf}
                  onClick={() => setConfFilter(conf)}
                  className={`btn btn-sm join-item ${
                    confFilter === conf
                      ? conf === 'East' ? 'btn-info' : conf === 'West' ? 'btn-warning' : 'btn-primary'
                      : ''
                  }`}
                >
                  {conf}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Player Filters */}
        {view === 'players' && (
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <label className="input input-bordered input-sm flex items-center gap-2 flex-1 min-w-[200px] max-w-[360px]">
              <Search size={14} className="opacity-50" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search players..."
                className="grow"
              />
            </label>

            <label className="input input-bordered input-sm flex items-center gap-2">
              <Filter size={14} className="opacity-50" />
              <select
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="select select-ghost select-sm p-0 focus:outline-none"
              >
                <option value="">All Teams</option>
                {teamNames.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>

            <div className="join">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  onClick={() => setPosFilter(pos)}
                  className={`btn btn-xs join-item ${posFilter === pos ? 'btn-primary' : ''}`}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Tables */}
        {view === 'players' ? (
          loadingPlayers ? (
            <div className="flex items-center justify-center py-20">
              <span className="loading loading-spinner loading-lg" />
            </div>
          ) : (
            <PlayerTable
              players={filteredPlayers}
              onSelect={(p) => setSelectedPlayer(p)}
              selectedForCompare={comparePlayers}
              onToggleCompare={handleToggleCompare}
            />
          )
        ) : loadingTeams ? (
          <div className="flex items-center justify-center py-20">
            <span className="loading loading-spinner loading-lg" />
          </div>
        ) : (
          <TeamTable
            teams={confFilter === 'All' ? teams : teams.filter((t) => t.conference === confFilter)}
          />
        )}
      </div>

      {/* Sticky compare bar */}
      {comparePlayers.length >= 1 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-base-200 border-t border-base-300 px-4 py-3 flex items-center justify-between shadow-2xl">
          <div className="flex items-center gap-3">
            <span className="text-xs opacity-50">{comparePlayers.length}/3 selected</span>
            <div className="flex items-center gap-2">
              {comparePlayers.map((p) => (
                <div key={p.id} className="flex items-center gap-1.5 bg-base-300 rounded-full pl-1 pr-2.5 py-1">
                  <div className="avatar">
                    <div className="w-5 rounded-full">
                      <img
                        src={p.headshot_url || ''}
                        alt=""
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    </div>
                  </div>
                  <span className="text-xs">{p.name.split(' ').pop()}</span>
                  <button onClick={() => handleToggleCompare(p)} className="ml-0.5 opacity-40 hover:opacity-100">
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setComparePlayers([])} className="btn btn-ghost btn-sm">
              Clear
            </button>
            <button
              onClick={() => setShowCompare(true)}
              disabled={comparePlayers.length < 2}
              className="btn btn-primary btn-sm gap-1.5"
            >
              <GitCompare size={14} />
              Compare {comparePlayers.length >= 2 ? comparePlayers.length : ''} Players
            </button>
          </div>
        </div>
      )}

      <PlayerModal player={selectedPlayer} onClose={() => setSelectedPlayer(null)} />
      {showCompare && (
        <CompareModal players={comparePlayers} onClose={() => setShowCompare(false)} />
      )}
    </div>
  );
}
