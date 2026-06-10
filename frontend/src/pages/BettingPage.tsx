import { useState } from 'react';
import { AlertTriangle, CalendarDays } from 'lucide-react';
import { useBettingPicks } from '../hooks/useBettingPicks';
import { useBetLedger } from '../hooks/useBetLedger';
import { BettingOddsBoard } from '../components/BettingOddsBoard';
import { BettingPicksPanel } from '../components/BettingPicksPanel';
import { BettingPrefsPanel } from '../components/BettingPrefsPanel';
import { BetLedger } from '../components/BetLedger';
import { BettingGlossary } from '../components/BettingGlossary';
import type { BettingPreferences } from '../api/client';

interface BettingPageProps {
  isLoggedIn: boolean;
}

export const BettingPage = ({ isLoggedIn }: BettingPageProps) => {
  const {
    odds, oddsLoading, oddsError, reloadOdds,
    picks, picksLoading, refreshing, picksError, reloadPicks,
  } = useBettingPicks(isLoggedIn);
  const { bets, summary, loading: ledgerLoading, error: ledgerError, trackBet, removeBet } = useBetLedger(isLoggedIn);
  const [unitSize, setUnitSize] = useState<number | undefined>(undefined);

  const handlePrefsSaved = (prefs: BettingPreferences): void => {
    setUnitSize(prefs.unit_size);
    // prefs feed the AI prompt — re-run the analysis with the new context.
    void reloadPicks(true);
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-5">
      <div className="alert alert-warning py-2.5 text-sm" role="alert">
        <AlertTriangle size={16} />
        <span>
          <span className="font-semibold">For entertainment only — not financial advice.</span>{' '}
          AI win-probability estimates are educated guesses, not predictions. Sportsbook lines are
          efficient and the house always takes a cut. Never bet money you can't afford to lose.
        </span>
      </div>

      {isLoggedIn ? (
        <>
          <BettingPrefsPanel onSaved={handlePrefsSaved} />
          <BettingPicksPanel
            picks={picks}
            loading={picksLoading}
            refreshing={refreshing}
            error={picksError}
            onReload={(refresh) => void reloadPicks(refresh)}
            onTrackBet={trackBet}
            unitSize={unitSize}
          />
          <BetLedger
            bets={bets}
            summary={summary}
            loading={ledgerLoading}
            error={ledgerError}
            games={odds}
            onTrackBet={trackBet}
            onRemoveBet={removeBet}
          />
        </>
      ) : (
        <div className="card bg-base-200">
          <div className="card-body flex flex-col items-center py-12 gap-2 text-center">
            <p className="font-semibold">Sign in to unlock AI betting picks</p>
            <p className="text-sm opacity-50 max-w-md">
              Get Best Value, Safe, and Hail Mary picks tailored to your preferences, a suggested
              parlay, stake sizing, and a bet tracker. The odds board below is free to browse.
            </p>
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">Upcoming Games & Odds</h2>
          <span className="text-xs opacity-40">next 7 days · implied win probability shown next to each price</span>
        </div>
        <BettingOddsBoard games={odds} loading={oddsLoading} error={oddsError} onRetry={reloadOdds} />
      </div>

      <BettingGlossary />

      <p className="text-xs opacity-40 text-center pb-2">
        For entertainment only. If betting stops being fun, call or text 1-800-GAMBLER.
      </p>
    </div>
  );
};
