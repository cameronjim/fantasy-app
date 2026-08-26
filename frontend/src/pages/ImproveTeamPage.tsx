import { useEffect, useState, useCallback } from 'react';
import { Lightbulb, Target, TrendingUp, RefreshCw } from 'lucide-react';
import { getWaiverSuggestions } from '../api/client';
import { ChatBox } from '../components/ChatBox';
import { PreferencesPrompt } from '../components/PreferencesPrompt';
import { getCachedSuggestions, setCachedSuggestions } from '../api/clientCaches';

interface Suggestion {
  name: string;
  reasoning: string;
}

interface ImproveTeamPageProps {
  isLoggedIn: boolean;
}

export const ImproveTeamPage = ({ isLoggedIn }: ImproveTeamPageProps) => {
  const initial = getCachedSuggestions();
  const [tradeTargets, setTradeTargets] = useState<Suggestion[]>(initial?.trade_targets ?? []);
  const [waiverPickups, setWaiverPickups] = useState<Suggestion[]>(initial?.waiver_pickups ?? []);
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [cachedAt, setCachedAt] = useState<string | null>(initial?.cached_at ?? null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [emptyRoster, setEmptyRoster] = useState(false);

  const loadSuggestions = useCallback(async (refresh = false): Promise<void> => {
    type SuggestionsResponse = Awaited<ReturnType<typeof getWaiverSuggestions>>;
    const apply = (d: SuggestionsResponse): void => {
      setTradeTargets(d.trade_targets || []);
      setWaiverPickups(d.waiver_pickups || []);
      setSummary(d.summary || '');
      setCachedAt(d.cached_at || null);
      setEmptyRoster(!!d.empty_roster);
    };

    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    let data: SuggestionsResponse;
    try {
      data = await getWaiverSuggestions(refresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggestions');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    apply(data);
    // never cache the empty-roster response, or a stale one about to be replaced.
    if (!data.empty_roster && !data.stale) {
      setCachedSuggestions(data);
    }
    setLoading(false);
    if (!refresh && data.stale) {
      // the server handed back expired suggestions, so regenerate behind the scenes.
      setRefreshing(true);
      try {
        const fresh = await getWaiverSuggestions(true);
        apply(fresh);
        if (!fresh.empty_roster) setCachedSuggestions(fresh);
      } catch {
      }
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (initial) return;
    loadSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

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
          ) : emptyRoster ? (
            <div className="card bg-base-200">
              <div className="card-body flex flex-col items-center py-16 gap-2 text-center">
                <p className="font-semibold text-sm">Add players to your team first</p>
                <p className="text-xs opacity-60 max-w-xs">
                  Go to <span className="font-medium">My Team</span> and add a few players. We'll suggest trades and waiver pickups based on your roster's weak categories.
                </p>
              </div>
            </div>
          ) : (
            <>
              {summary && (
                <div className="card bg-base-200">
                  <div className="card-body p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Lightbulb size={16} className="text-primary" />
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
