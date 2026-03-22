import { useEffect, useState, useCallback } from 'react';
import { Loader2, Sparkles, Target, TrendingUp, RefreshCw } from 'lucide-react';
import { getWaiverSuggestions } from '../api/client';
import ChatBox from '../components/ChatBox';

interface Suggestion {
  name: string;
  reasoning: string;
}

export default function ImproveTeamPage() {
  const [tradeTargets, setTradeTargets] = useState<Suggestion[]>([]);
  const [waiverPickups, setWaiverPickups] = useState<Suggestion[]>([]);
  const [summary, setSummary] = useState('');
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadSuggestions = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const data = await getWaiverSuggestions(refresh);
      setTradeTargets(data.trade_targets || []);
      setWaiverPickups(data.waiver_pickups || []);
      setSummary(data.summary || '');
      setCachedAt(data.cached_at || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggestions');
      setTradeTargets([]);
      setWaiverPickups([]);
      setSummary('');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const formatCacheTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  if (loading) {
    return (
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] p-16 flex flex-col items-center">
          <Loader2 size={32} className="text-[#3b82f6] animate-spin mb-4" />
          <p className="text-[#9ca3af] text-sm">AI is analyzing your roster and finding improvements...</p>
          <p className="text-[#4b5063] text-xs mt-1">This may take a moment</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] p-16 flex flex-col items-center">
          <p className="text-[#ef4444] text-sm mb-4">{error}</p>
          <button
            onClick={() => loadSuggestions()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[#3b82f6] text-white hover:bg-[#2563eb] transition-colors cursor-pointer"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-6">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {cachedAt && (
            <span className="text-xs text-[#4b5063]">
              Last updated {formatCacheTime(cachedAt)}
            </span>
          )}
        </div>
        <button
          onClick={() => loadSuggestions(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#252836] border border-[#2a2d3a] text-[#9ca3af] hover:text-white hover:border-[#3b82f6] transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh Suggestions'}
        </button>
      </div>

      {/* Summary */}
      {summary && (
        <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] p-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={16} className="text-[#f59e0b]" />
            <span className="text-sm font-semibold text-white">Strategy Summary</span>
          </div>
          <p className="text-sm text-[#d1d5db] leading-relaxed">{summary}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trade Targets */}
        <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2d3a] flex items-center gap-2">
            <Target size={16} className="text-[#3b82f6]" />
            <h2 className="text-sm font-semibold text-white">Trade Targets</h2>
          </div>
          <div className="p-4 space-y-3">
            {tradeTargets.length === 0 ? (
              <p className="text-sm text-[#6b7280] text-center py-4">No trade targets found. Add players to your roster first.</p>
            ) : (
              tradeTargets.map((t, i) => (
                <div key={i} className="bg-[#252836] rounded-lg p-3">
                  <div className="font-medium text-white text-sm mb-1">{t.name}</div>
                  <p className="text-xs text-[#9ca3af] leading-relaxed">{t.reasoning}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Waiver Pickups */}
        <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2d3a] flex items-center gap-2">
            <TrendingUp size={16} className="text-[#22c55e]" />
            <h2 className="text-sm font-semibold text-white">Waiver Wire Pickups</h2>
          </div>
          <div className="p-4 space-y-3">
            {waiverPickups.length === 0 ? (
              <p className="text-sm text-[#6b7280] text-center py-4">No waiver suggestions found. Add players to your roster first.</p>
            ) : (
              waiverPickups.map((w, i) => (
                <div key={i} className="bg-[#252836] rounded-lg p-3">
                  <div className="font-medium text-white text-sm mb-1">{w.name}</div>
                  <p className="text-xs text-[#9ca3af] leading-relaxed">{w.reasoning}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* AI Chat */}
      <ChatBox contextType="waiver" />
    </div>
  );
}
