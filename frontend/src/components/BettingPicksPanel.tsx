import { useState } from 'react';
import { Gem, Shield, Rocket, Layers, RefreshCw, Plus } from 'lucide-react';
import { formatAmerican, formatPercent, formatSignedPercent, formatMoney } from '../utils/formatOdds';
import type { BettingPick, BettingPicksResponse, NewBet } from '../types';

interface BettingPicksPanelProps {
  picks: BettingPicksResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  onReload: (refresh?: boolean) => void;
  onTrackBet: (bet: NewBet) => Promise<void>;
  unitSize?: number;
}

const CATEGORY_META = {
  best_value: { label: 'Best Value', badge: 'badge-success', icon: Gem, blurb: 'Biggest gaps between our estimated win chance and what the price implies.' },
  safe: { label: 'Safe', badge: 'badge-info', icon: Shield, blurb: 'High win probability, modest payout. Boring is fine.' },
  hail_mary: { label: 'Hail Mary', badge: 'badge-warning', icon: Rocket, blurb: 'Longshots with a real path. Expect these to miss more often than hit.' },
} as const;

interface PickCardProps {
  pick: BettingPick;
  onTrackBet: (bet: NewBet) => Promise<void>;
  unitSize?: number;
}

const PickCard = ({ pick, onTrackBet, unitSize }: PickCardProps) => {
  const suggested = pick.kelly?.suggested_stake;
  const defaultStake = suggested && suggested > 0 ? suggested : unitSize ?? 10;
  const [stake, setStake] = useState(defaultStake);
  const [tracking, setTracking] = useState(false);
  const [tracked, setTracked] = useState(false);
  const [trackError, setTrackError] = useState('');

  const handleTrack = async (): Promise<void> => {
    if (stake <= 0 || tracking) return;
    setTracking(true);
    setTrackError('');
    try {
      await onTrackBet({
        nba_game_id: pick.game_id,
        market: pick.market,
        selection: pick.selection,
        line: pick.market === 'moneyline' ? null : pick.line,
        american_odds: pick.american_odds,
        stake,
      });
      setTracked(true);
    } catch {
      setTrackError('Failed to track bet');
    } finally {
      setTracking(false);
    }
  };

  const edgePositive = pick.edge >= 0;

  return (
    <div className="bg-base-300 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-sm">
            {pick.selection_label}
            <span className="opacity-60 font-normal ml-1.5">{formatAmerican(pick.american_odds)}</span>
          </div>
          <div className="text-xs opacity-50">{pick.matchup} · {pick.tipoff}</div>
        </div>
        <span className={`badge badge-sm ${pick.confidence === 'high' ? 'badge-primary' : 'badge-ghost'}`}>
          {pick.confidence} confidence
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span title="What the sportsbook's price implies this outcome's chance is">
          <span className="opacity-50">Book says</span>{' '}
          <span className="font-medium">{formatPercent(pick.implied_prob)}</span>
        </span>
        <span title="The AI's estimate of the true win probability">
          <span className="opacity-50">AI says</span>{' '}
          <span className="font-medium">{formatPercent(pick.estimated_win_prob)}</span>
        </span>
        <span title="AI estimate minus implied probability. Positive = potential value.">
          <span className="opacity-50">Edge</span>{' '}
          <span className={`font-semibold ${edgePositive ? 'text-success' : 'text-error'}`}>
            {formatSignedPercent(pick.edge)}
          </span>
        </span>
      </div>

      <p className="text-xs opacity-60 leading-relaxed">{pick.rationale}</p>

      {pick.kelly === null && (
        <p className="text-xs opacity-40 italic">
          Set a bankroll in Betting Preferences to get suggested stake sizes.
        </p>
      )}
      {suggested != null && suggested > 0 && (
        <p className="text-xs opacity-60">
          Suggested stake: <span className="font-medium">{formatMoney(suggested)}</span>
          <span className="opacity-60"> (quarter-Kelly)</span>
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        {tracked ? (
          <span className="text-xs text-success font-medium">Added to your ledger ✓</span>
        ) : (
          <>
            <label className="input input-bordered input-xs flex items-center gap-1 w-24">
              $
              <input
                type="number"
                min={1}
                value={stake}
                onChange={(e) => setStake(parseFloat(e.target.value) || 0)}
                className="w-full"
                aria-label="Stake amount"
              />
            </label>
            <button onClick={handleTrack} disabled={tracking || stake <= 0} className="btn btn-primary btn-xs gap-1">
              <Plus size={12} />
              {tracking ? 'Tracking...' : 'Track this bet'}
            </button>
            {trackError && <span className="text-xs text-error">{trackError}</span>}
          </>
        )}
      </div>
    </div>
  );
};

export const BettingPicksPanel = ({ picks, loading, refreshing, error, onReload, onTrackBet, unitSize }: BettingPicksPanelProps) => {
  if (loading) {
    return (
      <div className="card bg-base-200">
        <div className="card-body flex flex-col items-center py-16 gap-3">
          <span className="loading loading-spinner loading-lg" />
          <p className="text-sm opacity-50">AI is studying the lines, ratings, and injury reports...</p>
          <p className="text-xs opacity-30">This may take a moment</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card bg-base-200">
        <div className="card-body flex flex-col items-center py-16 gap-4">
          <p className="text-error text-sm">{error}</p>
          <button onClick={() => onReload()} className="btn btn-primary btn-sm">Try Again</button>
        </div>
      </div>
    );
  }

  if (!picks || picks.no_games) {
    return (
      <div className="card bg-base-200">
        <div className="card-body flex flex-col items-center py-16 gap-2 text-center">
          <p className="font-semibold text-sm">No bettable games right now</p>
          <p className="text-xs opacity-60 max-w-xs">
            Sportsbooks haven't posted lines for upcoming games yet. Check back closer to game day.
          </p>
        </div>
      </div>
    );
  }

  const formatCacheTime = (iso: string): string =>
    new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          {picks.cached_at && (
            <span className="text-xs opacity-40">Last updated {formatCacheTime(picks.cached_at)}</span>
          )}
        </div>
        <button onClick={() => onReload(true)} disabled={refreshing} className="btn btn-ghost btn-xs gap-1.5">
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Re-analyzing...' : 'Re-analyze'}
        </button>
      </div>

      {picks.summary && (
        <div className="card bg-base-200">
          <div className="card-body p-4">
            <p className="text-sm opacity-80 leading-relaxed">{picks.summary}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).map((category) => {
          const meta = CATEGORY_META[category];
          const Icon = meta.icon;
          const categoryPicks = picks.picks.filter((p) => p.category === category);
          return (
            <div key={category} className="card bg-base-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-base-300">
                <div className="flex items-center gap-2">
                  <Icon size={16} />
                  <h2 className="text-sm font-semibold">{meta.label}</h2>
                  <span className={`badge badge-sm ${meta.badge}`}>{categoryPicks.length}</span>
                </div>
                <p className="text-[11px] opacity-50 mt-1">{meta.blurb}</p>
              </div>
              <div className="p-3 space-y-3">
                {categoryPicks.length === 0 ? (
                  <p className="text-xs opacity-40 text-center py-4">No {meta.label.toLowerCase()} picks on this slate.</p>
                ) : (
                  categoryPicks.map((pick) => (
                    <PickCard
                      key={`${pick.game_id}-${pick.market}-${pick.selection}`}
                      pick={pick}
                      onTrackBet={onTrackBet}
                      unitSize={unitSize}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {picks.parlay && (
        <div className="card bg-base-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-base-300 flex items-center gap-2">
            <Layers size={16} className="text-secondary" />
            <h2 className="text-sm font-semibold">Suggested Parlay</h2>
            <span className="badge badge-sm badge-secondary">
              {formatAmerican(picks.parlay.combined_american)}
            </span>
            <span className="badge badge-sm badge-ghost" title="Combined implied probability of all legs hitting">
              {formatPercent(picks.parlay.combined_implied_prob)} to hit
            </span>
          </div>
          <div className="p-4 space-y-3">
            <ul className="space-y-1.5">
              {picks.parlay.legs.map((leg) => (
                <li key={`${leg.game_id}-${leg.market}-${leg.selection}`} className="text-sm flex items-baseline gap-2">
                  <span className="font-medium">{leg.selection_label}</span>
                  <span className="text-xs opacity-50">{leg.matchup} · {formatAmerican(leg.american_odds)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs opacity-60 leading-relaxed">{picks.parlay.rationale}</p>
            <p className="text-xs text-warning leading-relaxed">{picks.parlay.ev_note}</p>
          </div>
        </div>
      )}
    </div>
  );
};
