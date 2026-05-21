import { useEffect, useState, useCallback } from 'react';
import { Search, Plus, Trash2, RefreshCw } from 'lucide-react';
import { getMyRoster, getPlayers, addToRoster, dropFromRoster, getTeamAnalysis } from '../api/client';
import type { Player, RosterPlayer, TeamAnalysis } from '../types';

const CAT_COLORS: Record<string, string> = {
  strong: 'badge-success',
  average: 'badge-warning',
  weak: 'badge-error',
};

interface FantasyPageProps {
  isLoggedIn: boolean;
}

export const FantasyPage = ({ isLoggedIn }: FantasyPageProps) => {
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Player[]>([]);
  const [searching, setSearching] = useState(false);
  const [analysis, setAnalysis] = useState<TeamAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [rosterLoading, setRosterLoading] = useState(true);

  const loadRoster = useCallback(async (): Promise<void> => {
    try {
      const data = await getMyRoster();
      setRoster(data);
    } catch {
      setRoster([]);
    } finally {
      setRosterLoading(false);
    }
  }, []);

  const loadAnalysis = useCallback(async (): Promise<void> => {
    setAnalysisLoading(true);
    try {
      const data = await getTeamAnalysis();
      setAnalysis(data);
    } catch {
      setAnalysis(null);
    } finally {
      setAnalysisLoading(false);
    }
  }, []);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  useEffect(() => {
    if (!search.trim()) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await getPlayers({ search: search.trim() });
        const rosterIds = new Set(roster.map((r) => r.player_id || r.id));
        setSearchResults(results.filter((p) => !rosterIds.has(p.id)).slice(0, 10));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search, roster]);

  const handleAdd = async (playerId: number): Promise<void> => {
    try {
      await addToRoster(playerId);
      setSearch('');
      setSearchResults([]);
      await loadRoster();
      setAnalysis(null);
    } catch { /* roster add failed silently to avoid blocking ui */ }
  };

  const handleDrop = async (playerId: number): Promise<void> => {
    try {
      await dropFromRoster(playerId);
      await loadRoster();
      setAnalysis(null);
    } catch { /* roster drop failed silently to avoid blocking ui */ }
  };

  const n = (v: unknown): number => Number(v) || 0;

  const injuryBadge = (status: string | null): JSX.Element | null => {
    if (!status) return null;
    const cls = status === 'Out' ? 'badge-error'
      : ['Day-To-Day', 'Day_To_Day', 'Questionable'].includes(status) ? 'badge-warning'
      : status === 'Probable' ? 'badge-success'
      : 'badge-error';
    return <span className={`badge badge-xs ml-2 ${cls}`}>{status.replace(/_/g, ' ')}</span>;
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-5">
      {isLoggedIn && (
        <div className="card bg-base-200">
          <div className="card-body p-4">
            <label className="input input-bordered flex items-center gap-2">
              <Search size={16} className="opacity-50" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search players to add to your team..."
                className="grow"
              />
              {searching && <span className="loading loading-spinner loading-xs" />}
            </label>

            {searchResults.length > 0 && (
              <div className="mt-2 space-y-1 max-h-[300px] overflow-y-auto">
                {searchResults.map((player) => (
                  <div key={player.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-base-300 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="avatar">
                        <div className="w-7 rounded-full">
                          <img
                            src={player.headshot_url || ''}
                            alt=""
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        </div>
                      </div>
                      <span className="text-sm font-medium">{player.name}</span>
                      <span className="text-xs opacity-50">{player.position} · {player.team}</span>
                      <span className="text-xs opacity-70">{n(player.points_per_game).toFixed(1)} PPG</span>
                    </div>
                    <button onClick={() => handleAdd(player.id)} className="btn btn-primary btn-xs gap-1">
                      <Plus size={12} /> Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card bg-base-200 overflow-hidden">
        <div className="card-body p-0">
          <div className="px-4 py-3 border-b border-base-300">
            <h3 className="font-semibold text-sm">My Roster ({roster.length} players)</h3>
          </div>

          {!isLoggedIn ? (
            <div className="text-center p-12">
              <p className="font-semibold text-sm mb-1">Sign in to use My Team</p>
              <p className="opacity-40 text-xs">Use the Sign In button in the top right to manage your roster.</p>
            </div>
          ) : rosterLoading ? (
            <div className="flex justify-center p-8">
              <span className="loading loading-spinner loading-lg" />
            </div>
          ) : roster.length === 0 ? (
            <div className="text-center p-12">
              <p className="opacity-40 text-sm">No players on your roster yet</p>
              <p className="opacity-25 text-xs mt-1">Use the search bar above to add players</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table table-zebra table-sm">
                <thead>
                  <tr>
                    {['Player', 'Pos', 'Team', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'FG%', 'FT%', '3PM', 'TO', ...(isLoggedIn ? [''] : [])].map((h, i) => (
                      <th key={`${h}-${i}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roster.map((p) => (
                    <tr key={p.id} className="hover">
                      <td className="font-medium whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <div className="avatar">
                            <div className="w-6 rounded-full">
                              <img
                                src={p.headshot_url || ''}
                                alt=""
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                              />
                            </div>
                          </div>
                          {p.name}{injuryBadge(p.injury_status)}
                        </span>
                      </td>
                      <td className="opacity-60">{p.position}</td>
                      <td className="opacity-60">{p.team}</td>
                      <td>{n(p.points_per_game).toFixed(1)}</td>
                      <td>{n(p.rebounds_per_game).toFixed(1)}</td>
                      <td>{n(p.assists_per_game).toFixed(1)}</td>
                      <td>{n(p.steals_per_game).toFixed(1)}</td>
                      <td>{n(p.blocks_per_game).toFixed(1)}</td>
                      <td>{n(p.field_goal_percentage).toFixed(1)}%</td>
                      <td>{n(p.free_throw_percentage).toFixed(1)}%</td>
                      <td>{n(p.three_pointers_made).toFixed(1)}</td>
                      <td>{n(p.turnovers_per_game).toFixed(1)}</td>
                      {isLoggedIn && (
                        <td>
                          <button
                            onClick={() => handleDrop(p.player_id || p.id)}
                            className="btn btn-error btn-xs gap-1"
                          >
                            <Trash2 size={12} /> Drop
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {isLoggedIn && roster.length > 0 && (
        <div className="card bg-base-200 overflow-hidden">
          <div className="card-body p-0">
            <div className="px-4 py-3 border-b border-base-300 flex items-center justify-between">
              <h3 className="font-semibold text-sm">9-Category Analysis</h3>
              <button
                onClick={loadAnalysis}
                disabled={analysisLoading}
                className="btn btn-ghost btn-xs gap-1.5"
              >
                <RefreshCw size={12} className={analysisLoading ? 'animate-spin' : ''} />
                {analysisLoading ? 'Analyzing...' : 'Refresh'}
              </button>
            </div>

            {analysisLoading && !analysis ? (
              <div className="flex flex-col items-center p-8 gap-3">
                <span className="loading loading-spinner loading-lg" />
                <p className="text-sm opacity-50">AI is analyzing your roster...</p>
              </div>
            ) : analysis?.categories ? (
              <div className="p-4">
                <div className="flex flex-wrap gap-2 mb-4">
                  {Object.entries(analysis.categories).map(([cat, rating]) => (
                    <span key={cat} className={`badge badge-lg ${CAT_COLORS[rating] ?? 'badge-warning'}`}>
                      {cat}
                      <span className="ml-1 opacity-70 capitalize text-xs">· {rating}</span>
                    </span>
                  ))}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {[
                    { title: 'Strengths', items: analysis.strengths, cls: 'text-success' },
                    { title: 'Weaknesses', items: analysis.weaknesses, cls: 'text-error' },
                    { title: 'Suggestions', items: analysis.suggestions, cls: 'text-info' },
                  ].map((section) => (
                    <div key={section.title} className="space-y-2">
                      <p className={`text-xs font-bold uppercase tracking-wider ${section.cls}`}>{section.title}</p>
                      <div className="space-y-1.5">
                        {section.items?.map((item, i) => (
                          <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-base-300">
                            <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${section.cls} bg-current`} />
                            <span className="text-xs leading-relaxed opacity-80">{item}</span>
                          </div>
                        ))}
                        {(!section.items || section.items.length === 0) && (
                          <p className="text-xs opacity-25 italic px-3">None identified</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : !analysisLoading ? (
              <div className="p-6 text-center flex flex-col items-center gap-3">
                <p className="text-sm opacity-40">Add your players, then analyze your team</p>
                <button onClick={loadAnalysis} className="btn btn-primary btn-sm">Analyze My Team</button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
