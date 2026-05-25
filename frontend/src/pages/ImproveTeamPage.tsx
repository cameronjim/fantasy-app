import { useEffect, useState, useCallback } from 'react';
import { Sparkles, Target, TrendingUp, RefreshCw } from 'lucide-react';
import { getWaiverSuggestions } from '../api/client';
import { ChatBox } from '../components/ChatBox';
import { PreferencesPrompt } from '../components/PreferencesPrompt';

interface Suggestion {
  name: string;
  reasoning: string;
}

interface ImproveTeamPageProps {
  isLoggedIn: boolean;
}

export const ImproveTeamPage = ({ isLoggedIn }: ImproveTeamPageProps) => {
  const [tradeTargets, setTradeTargets] = useState<Suggestion[]>([]);
  const [waiverPickups, setWaiverPickups] = useState<Suggestion[]>([]);
  const [summary, setSummary] = useState('');
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadSuggestions = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const data = await getWaiverSuggestions(refresh);
      setTradeTargets(data.trade_targets || []);
      setWaiverPickups(data.waiver_pickups || []);
      setSummary(data.summary || '');
      setCachedAt(data.cached_at || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggestions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isLoggedIn) loadSuggestions();
  }, [isLoggedIn, loadSuggestions]);

  const formatCacheTime = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-5">
      {isLoggedIn && <PreferencesPrompt />}
      {isLoggedIn ? (
        <>
          <div className="flex items-center justify-between">
            <div>
              {cachedAt && (
                <span className="text-xs opacity-40">Last updated {formatCacheTime(cachedAt)}</span>
              )}
            </div>
            <button
              onClick={() => loadSuggestions(true)}
              disabled={refreshing || loading}
              className="btn btn-ghost btn-xs gap-1.5"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Refreshing...' : 'Refresh Suggestions'}
            </button>
          </div>

          {loading ? (
            <div className="card bg-base-200">
              <div className="card-body flex flex-col items-center py-16 gap-3">
                <span className="loading loading-spinner loading-lg" />
                <p className="text-sm opacity-50">AI is analyzing your roster and finding improvements...</p>
                <p className="text-xs opacity-30">This may take a moment</p>
              </div>
            </div>
          ) : error ? (
            <div className="card bg-base-200">
              <div className="card-body flex flex-col items-center py-16 gap-4">
                <p className="text-error text-sm">{error}</p>
                <button onClick={() => loadSuggestions()} className="btn btn-primary btn-sm">Try Again</button>
              </div>
            </div>
          ) : (
            <>
              {summary && (
                <div className="card bg-base-200">
                  <div className="card-body p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Sparkles size={16} className="text-warning" />
                      <span className="text-sm font-semibold">Strategy Summary</span>
                    </div>
                    <p className="text-sm opacity-80 leading-relaxed">{summary}</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="card bg-base-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-base-300 flex items-center gap-2">
                    <Target size={16} className="text-primary" />
                    <h2 className="text-sm font-semibold">Trade Targets</h2>
                  </div>
                  <div className="p-4 space-y-3">
                    {tradeTargets.length === 0 ? (
                      <p className="text-sm opacity-40 text-center py-4">No trade targets found. Add players to your roster first.</p>
                    ) : (
                      tradeTargets.map((t, i) => (
                        <div key={i} className="bg-base-300 rounded-lg p-3">
                          <div className="font-medium text-sm mb-1">{t.name}</div>
                          <p className="text-xs opacity-60 leading-relaxed">{t.reasoning}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="card bg-base-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-base-300 flex items-center gap-2">
                    <TrendingUp size={16} className="text-success" />
                    <h2 className="text-sm font-semibold">Waiver Wire Pickups</h2>
                  </div>
                  <div className="p-4 space-y-3">
                    {waiverPickups.length === 0 ? (
                      <p className="text-sm opacity-40 text-center py-4">No waiver suggestions found. Add players to your roster first.</p>
                    ) : (
                      waiverPickups.map((w, i) => (
                        <div key={i} className="bg-base-300 rounded-lg p-3">
                          <div className="font-medium text-sm mb-1">{w.name}</div>
                          <p className="text-xs opacity-60 leading-relaxed">{w.reasoning}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="card bg-base-200">
          <div className="card-body flex flex-col items-center py-16 gap-2 text-center">
            <p className="font-semibold">Sign in to unlock AI suggestions</p>
            <p className="text-sm opacity-50">Use the Sign In button in the top right to get trade targets, waiver pickups, and AI chat.</p>
          </div>
        </div>
      )}

      <ChatBox contextType="waiver" isLoggedIn={isLoggedIn} />
    </div>
  );
};
