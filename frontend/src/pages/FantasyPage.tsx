import { useEffect, useState, useCallback } from 'react';
import { Search, Plus, Trash2, Loader2, RefreshCw } from 'lucide-react';
import { getMyRoster, getPlayers, addToRoster, dropFromRoster, getTeamAnalysis } from '../api/client';
import type { Player, RosterPlayer, TeamAnalysis } from '../types';

const CAT_LABELS: Record<string, string> = {
  PTS: 'Points', REB: 'Rebounds', AST: 'Assists', STL: 'Steals', BLK: 'Blocks',
  'FG%': 'Field Goal %', 'FT%': 'Free Throw %', '3PM': '3-Pointers Made', TO: 'Turnovers',
};

const CAT_COLORS: Record<string, string> = {
  strong: 'bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30',
  average: 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30',
  weak: 'bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/30',
};

export default function FantasyPage() {
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Player[]>([]);
  const [searching, setSearching] = useState(false);
  const [analysis, setAnalysis] = useState<TeamAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [rosterLoading, setRosterLoading] = useState(true);

  const loadRoster = useCallback(async () => {
    try {
      const data = await getMyRoster();
      setRoster(data);
    } catch {
      setRoster([]);
    } finally {
      setRosterLoading(false);
    }
  }, []);

  const loadAnalysis = useCallback(async () => {
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

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  // Auto-analyze when roster loads and has players
  useEffect(() => {
    if (roster.length > 0 && !analysis && !analysisLoading) {
      loadAnalysis();
    }
  }, [roster, analysis, analysisLoading, loadAnalysis]);

  // Search players
  useEffect(() => {
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
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

  const handleAdd = async (playerId: number) => {
    try {
      await addToRoster(playerId);
      setSearch('');
      setSearchResults([]);
      await loadRoster();
      setAnalysis(null); // cache will be invalidated on next refresh since roster changed
    } catch { /* skip */ }
  };

  const handleDrop = async (playerId: number) => {
    try {
      await dropFromRoster(playerId);
      await loadRoster();
      setAnalysis(null);
    } catch { /* skip */ }
  };

  const n = (v: unknown) => Number(v) || 0;

  const injuryBadge = (status: string | null) => {
    if (!status) return null;
    const colors: Record<string, string> = {
      Out: 'bg-[#ef4444]/20 text-[#ef4444]',
      'Day-To-Day': 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Day_To_Day: 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Questionable: 'bg-[#f59e0b]/20 text-[#f59e0b]',
      Probable: 'bg-[#22c55e]/20 text-[#22c55e]',
    };
    return (
      <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${colors[status] || 'bg-[#ef4444]/20 text-[#ef4444]'}`}>
        {status.replace(/_/g, ' ')}
      </span>
    );
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-5">
      {/* Add Players */}
      <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] p-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6b7280]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search players to add to your team..."
            className="w-full bg-[#252836] border border-[#2a2d3a] rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-[#6b7280] focus:outline-none focus:border-[#3b82f6] transition-colors"
          />
          {searching && <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#3b82f6] animate-spin" />}
        </div>

        {searchResults.length > 0 && (
          <div className="mt-2 space-y-1 max-h-[300px] overflow-y-auto">
            {searchResults.map((player) => (
              <div key={player.id} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-[#252836] transition-colors">
                <div className="flex items-center gap-3">
                  <img
                    src={player.headshot_url || ''}
                    alt=""
                    className="w-7 h-7 rounded-full object-cover object-top bg-[#252836] flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="text-sm font-medium text-white">{player.name}</span>
                  <span className="text-xs text-[#6b7280]">{player.position} - {player.team}</span>
                  <span className="text-xs text-[#9ca3af]">{n(player.ppg).toFixed(1)} PPG</span>
                </div>
                <button
                  onClick={() => handleAdd(player.id)}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium bg-[#3b82f6]/10 text-[#3b82f6] hover:bg-[#3b82f6]/20 transition-colors cursor-pointer"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Roster */}
      <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2a2d3a]">
          <h3 className="text-sm font-semibold text-white">My Roster ({roster.length} players)</h3>
        </div>

        {rosterLoading ? (
          <div className="p-8 flex justify-center">
            <Loader2 size={24} className="text-[#3b82f6] animate-spin" />
          </div>
        ) : roster.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-[#6b7280] text-sm">No players on your roster yet</p>
            <p className="text-[#4b5063] text-xs mt-1">Use the search bar above to add players</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#252836] border-b border-[#2a2d3a]">
                  {['Player', 'Pos', 'Team', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'FG%', 'FT%', '3PM', 'TO', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-[11px] font-semibold text-[#9ca3af] uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roster.map((p, i) => (
                  <tr key={p.id} className={`border-b border-[#2a2d3a] last:border-b-0 hover:bg-[#2a2d3a] transition-colors ${i % 2 === 0 ? 'bg-[#0f1117]' : 'bg-[#151822]'}`}>
                    <td className="px-3 py-2.5 font-medium text-white whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <img
                          src={p.headshot_url || ''}
                          alt=""
                          className="w-6 h-6 rounded-full object-cover object-top bg-[#252836] flex-shrink-0"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                        {p.name}{injuryBadge(p.injury_status)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[#9ca3af]">{p.position}</td>
                    <td className="px-3 py-2.5 text-[#9ca3af]">{p.team}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.ppg).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.rpg).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.apg).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.spg).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.bpg).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.fg_pct).toFixed(1)}%</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.ft_pct).toFixed(1)}%</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.three_pm).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-[#d1d5db]">{n(p.tov).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => handleDrop(p.player_id || p.id)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#ef4444]/10 text-[#ef4444] hover:bg-[#ef4444]/20 transition-colors cursor-pointer">
                        <Trash2 size={12} /> Drop
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 9-Cat Analysis */}
      {roster.length > 0 && (
        <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2d3a] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">9-Category Analysis</h3>
            <button
              onClick={loadAnalysis}
              disabled={analysisLoading}
              className="flex items-center gap-1.5 text-xs text-[#3b82f6] hover:text-[#60a5fa] transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw size={12} className={analysisLoading ? 'animate-spin' : ''} />
              {analysisLoading ? 'Analyzing...' : 'Refresh'}
            </button>
          </div>

          {analysisLoading && !analysis ? (
            <div className="p-8 flex flex-col items-center">
              <Loader2 size={28} className="text-[#3b82f6] animate-spin mb-3" />
              <p className="text-[#9ca3af] text-sm">AI is analyzing your roster...</p>
            </div>
          ) : analysis?.categories ? (
            <div className="p-4">
              {/* Category grid */}
              <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2 mb-4">
                {Object.entries(analysis.categories).map(([cat, rating]) => (
                  <div key={cat} className={`rounded-lg border px-3 py-2.5 text-center ${CAT_COLORS[rating] || CAT_COLORS.average}`}>
                    <div className="text-xs font-bold uppercase">{cat}</div>
                    <div className="text-[10px] mt-0.5 opacity-80 capitalize">{rating}</div>
                  </div>
                ))}
              </div>

              {/* Strengths / Weaknesses / Suggestions */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { title: 'Strengths', items: analysis.strengths, color: '#22c55e' },
                  { title: 'Weaknesses', items: analysis.weaknesses, color: '#ef4444' },
                  { title: 'Suggestions', items: analysis.suggestions, color: '#3b82f6' },
                ].map((section) => (
                  <div key={section.title} className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: section.color }}>{section.title}</span>
                    <div className="space-y-1.5">
                      {section.items?.map((item, i) => (
                        <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[#252836]">
                          <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: section.color }} />
                          <span className="text-xs text-[#d1d5db] leading-relaxed">{item}</span>
                        </div>
                      ))}
                      {(!section.items || section.items.length === 0) && (
                        <p className="text-xs text-[#4b5063] italic px-3">None identified</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : !analysisLoading ? (
            <div className="p-6 text-center">
              <p className="text-sm text-[#6b7280]">Click Refresh to analyze your team</p>
            </div>
          ) : null}
        </div>
      )}

    </div>
  );
}
