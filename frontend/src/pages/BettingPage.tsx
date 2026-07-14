import { useBettingPicks } from '../hooks/useBettingPicks';
import { useBetLedger } from '../hooks/useBetLedger';
import { BettingOddsBoard } from '../components/BettingOddsBoard';
import { BettingPicksPanel } from '../components/BettingPicksPanel';
import { BettingPrefsPanel } from '../components/BettingPrefsPanel';
import { BetLedger } from '../components/BetLedger';
import { BettingGlossary } from '../components/BettingGlossary';
import { ChatBox } from '../components/ChatBox';

interface BettingPageProps {
  isLoggedIn: boolean;
}

export const BettingPage = ({ isLoggedIn }: BettingPageProps) => {
  const {
    odds, oddsLoading, oddsError, reloadOdds,
    picks, picksLoading, refreshing, picksError, reloadPicks,
  } = useBettingPicks(isLoggedIn);
  const {
    bets, summary, loading: ledgerLoading, error: ledgerError,
    trackBet, settleBet, removeBet,
  } = useBetLedger(isLoggedIn);

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 space-y-5">
      {isLoggedIn ? (
        <>
          <BettingPrefsPanel onSaved={() => void reloadPicks(true)} />
          <BettingPicksPanel
            picks={picks}
            loading={picksLoading}
            refreshing={refreshing}
            error={picksError}
            onReload={(refresh) => void reloadPicks(refresh)}
          />
          <BetLedger
            bets={bets}
            summary={summary}
            loading={ledgerLoading}
            error={ledgerError}
            games={odds}
            onTrackBet={trackBet}
            onSettleBet={settleBet}
            onRemoveBet={removeBet}
          />
        </>
      ) : (
        <div className="card bg-base-200">
          <div className="card-body flex flex-col items-center py-12 gap-2 text-center">
            <p className="font-semibold">Sign in to unlock AI betting picks</p>
            <p className="text-sm opacity-50 max-w-md">
              Get Best Value, Safe, and Hail Mary picks tailored to your preferences, a suggested
              parlay, and a bet tracker. The odds board below is free to browse.
            </p>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold mb-3">Upcoming Games & Odds</h2>
        <BettingOddsBoard games={odds} loading={oddsLoading} error={oddsError} onRetry={reloadOdds} />
      </div>

      <ChatBox
        contextType="betting"
        isLoggedIn={isLoggedIn}
        emptyHint="Ask about tonight's lines, a specific matchup, or betting strategy."
      />

      <BettingGlossary />

      <p className="text-xs opacity-40 text-center pb-2">
        For entertainment only, not financial advice. If betting stops being fun, call or text 1-800-GAMBLER.
      </p>
    </div>
  );
};
