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
          <div className="flex rounded-lg bg-[#1a1d29] border border-[#2a2d3a] overflow-hidden">
            <button
              onClick={() => setView('players')}
              className={`px-5 py-2 text-sm font-medium transition-colors cursor-pointer ${
                view === 'players'
                  ? 'bg-[#3b82f6] text-white'
                  : 'text-[#9ca3af] hover:text-white hover:bg-[#252836]'
              }`}
            >
              Players
            </button>
            <button
              onClick={() => setView('teams')}
              className={`px-5 py-2 text-sm font-medium transition-colors cursor-pointer ${
                view === 'teams'
                  ? 'bg-[#3b82f6] text-white'
                  : 'text-[#9ca3af] hover:text-white hover:bg-[#252836]'
              }`}
            >
              Teams
            </button>
          </div>

          {view === 'players' && (
            <span className="text-xs text-[#6b7280]">
              {filteredPlayers.length} player{filteredPlayers.length !== 1 ? 's' : ''}
            </span>
          )}

          {view === 'teams' && (
            <div className="flex rounded-lg bg-[#1a1d29] border border-[#2a2d3a] overflow-hidden">
              {(['All', 'East', 'West'] as const).map((conf) => (
                <button
                  key={conf}
                  onClick={() => setConfFilter(conf)}
                  className={`px-4 py-2 text-xs font-medium transition-colors cursor-pointer ${
                    confFilter === conf
                      ? conf === 'East'
                        ? 'bg-[#1d4ed8] text-white'
                        : conf === 'West'
                        ? 'bg-[#b45309] text-white'
                        : 'bg-[#3b82f6] text-white'
                      : 'text-[#9ca3af] hover:text-white hover:bg-[#252836]'
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
            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-[360px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6b7280]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search players..."
                className="w-full bg-[#1a1d29] border border-[#2a2d3a] rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none focus:border-[#3b82f6] transition-colors"
              />
            </div>

            {/* Team Filter */}
            <div className="relative">
              <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6b7280]" />
              <select
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="appearance-none bg-[#1a1d29] border border-[#2a2d3a] rounded-lg pl-8 pr-8 py-2 text-sm text-white focus:outline-none focus:border-[#3b82f6] transition-colors cursor-pointer"
              >
                <option value="">All Teams</option>
                {teamNames.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {/* Position Filter */}
            <div className="flex rounded-lg bg-[#1a1d29] border border-[#2a2d3a] overflow-hidden">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  onClick={() => setPosFilter(pos)}
                  className={`px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                    posFilter === pos
                      ? 'bg-[#3b82f6] text-white'
                      : 'text-[#9ca3af] hover:text-white hover:bg-[#252836]'
                  }`}
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
              <div className="w-8 h-8 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
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
            <div className="w-8 h-8 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <TeamTable
            teams={confFilter === 'All' ? teams : teams.filter((t) => t.conference === confFilter)}
          />
        )}
      </div>

      {/* Sticky compare bar */}
      {comparePlayers.length >= 1 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#1a1d29] border-t border-[#2a2d3a] px-4 py-3 flex items-center justify-between shadow-2xl">
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#9ca3af]">
              {comparePlayers.length}/3 selected
            </span>
            <div className="flex items-center gap-2">
              {comparePlayers.map((p) => (
                <div key={p.id} className="flex items-center gap-1.5 bg-[#252836] rounded-full pl-1 pr-2.5 py-1">
                  <img
                    src={p.headshot_url || ''}
                    alt=""
                    className="w-5 h-5 rounded-full object-cover object-top bg-[#2a2d3a]"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="text-xs text-white">{p.name.split(' ').pop()}</span>
                  <button
                    onClick={() => handleToggleCompare(p)}
                    className="ml-0.5 text-[#6b7280] hover:text-white cursor-pointer"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setComparePlayers([])}
              className="px-3 py-1.5 text-xs text-[#9ca3af] hover:text-white transition-colors cursor-pointer"
            >
              Clear
            </button>
            <button
              onClick={() => setShowCompare(true)}
              disabled={comparePlayers.length < 2}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[#3b82f6] text-white hover:bg-[#2563eb] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <GitCompare size={14} />
              Compare {comparePlayers.length >= 2 ? comparePlayers.length : ''} Players
            </button>
          </div>
        </div>
      )}

      {/* Modals */}
      <PlayerModal
        player={selectedPlayer}
        onClose={() => setSelectedPlayer(null)}
      />
      {showCompare && (
        <CompareModal
          players={comparePlayers}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}
