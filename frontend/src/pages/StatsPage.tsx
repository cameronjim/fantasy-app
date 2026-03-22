import { useEffect, useState } from 'react';
import { Search, Filter } from 'lucide-react';
import ScoreboardStrip from '../components/ScoreboardStrip';
import PlayerTable from '../components/PlayerTable';
import TeamTable from '../components/TeamTable';
import PlayerModal from '../components/PlayerModal';
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

  // Get unique team names for the filter dropdown
  const teamNames = [...new Set(players.map((p) => p.team))].sort();

  // Filter players
  const filteredPlayers = players.filter((p) => {
    const matchesSearch =
      !search || p.name.toLowerCase().includes(search.toLowerCase());
    const matchesTeam = !teamFilter || p.team === teamFilter;
    const matchesPos = posFilter === 'All' || p.position === posFilter;
    return matchesSearch && matchesTeam && matchesPos;
  });

  return (
    <div>
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
            />
          )
        ) : loadingTeams ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <TeamTable teams={teams} />
        )}
      </div>

      {/* Player Modal */}
      <PlayerModal
        player={selectedPlayer}
        onClose={() => setSelectedPlayer(null)}
      />
    </div>
  );
}
