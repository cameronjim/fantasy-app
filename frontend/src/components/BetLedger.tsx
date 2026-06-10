import { useState } from 'react';
import { Trash2, NotebookPen } from 'lucide-react';
import { formatAmerican, formatMoney, formatPercent, formatLine } from '../utils/formatOdds';
import type { Bet, BettingGame, LedgerSummary, NewBet, BetMarket, BetSelection } from '../types';

interface BetLedgerProps {
  bets: Bet[];
  summary: LedgerSummary;
  loading: boolean;
  error: string;
  games: BettingGame[];
  onTrackBet: (bet: NewBet) => Promise<void>;
  onRemoveBet: (id: number) => Promise<void>;
}

const STATUS_BADGE: Record<Bet['status'], string> = {
  pending: 'badge-ghost',
  won: 'badge-success',
  lost: 'badge-error',
  push: 'badge-warning',
};

/** human label for a stored bet, e.g. "Knicks -2.5" or "Over 216.5" */
function betLabel(bet: Bet): string {
  if (bet.market === 'total') {
    return `${bet.selection === 'over' ? 'Over' : 'Under'} ${bet.line}`;
  }
  const team = bet.selection === 'home' ? bet.home_team : bet.away_team;
  if (bet.market === 'moneyline') return `${team} ML`;
  return `${team} ${bet.line != null ? formatLine(bet.line) : ''}`.trim();
}

interface AddBetFormProps {
  games: BettingGame[];
  onTrackBet: (bet: NewBet) => Promise<void>;
  onDone: () => void;
}

const AddBetForm = ({ games, onTrackBet, onDone }: AddBetFormProps) => {
  const [gameId, setGameId] = useState('');
  const [market, setMarket] = useState<BetMarket>('spread');
  const [selection, setSelection] = useState<BetSelection>('home');
  const [stake, setStake] = useState(10);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const game = games.find((g) => g.nba_game_id === gameId);

  // line/odds come from the posted markets for the chosen game+selection so
  // the user doesn't have to type them; unavailable markets are disabled.
  const resolve = (): { line: number | null; odds: number } | null => {
    if (!game) return null;
    const { spread, total, moneyline } = game.markets;
    if (market === 'spread' && spread) {
      return selection === 'home'
        ? { line: spread.home_line, odds: spread.home_price }
        : { line: spread.away_line, odds: spread.away_price };
    }
    if (market === 'total' && total) {
      return { line: total.line, odds: selection === 'over' ? total.over_price : total.under_price };
    }
    if (market === 'moneyline' && moneyline) {
      return { line: null, odds: selection === 'home' ? moneyline.home : moneyline.away };
    }
    return null;
  };
  const resolved = resolve();

  const selectionChoices: Array<{ value: BetSelection; label: string }> =
    market === 'total'
      ? [{ value: 'over', label: 'Over' }, { value: 'under', label: 'Under' }]
      : [
          { value: 'away', label: game ? game.away_team : 'Away' },
          { value: 'home', label: game ? game.home_team : 'Home' },
        ];

  const handleMarketChange = (next: BetMarket): void => {
    setMarket(next);
    setSelection(next === 'total' ? 'over' : 'home');
  };

  const handleSubmit = async (): Promise<void> => {
    if (!game || !resolved || stake <= 0 || saving) return;
    setSaving(true);
    setError('');
    try {
      await onTrackBet({
        nba_game_id: game.nba_game_id,
        market,
        selection,
        line: resolved.line,
        american_odds: resolved.odds,
        stake,
      });
      onDone();
    } catch {
      setError('Failed to add bet');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-base-300 rounded-lg p-3 space-y-3">
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs font-semibold block mb-1" htmlFor="addbet-game">Game</label>
          <select
            id="addbet-game"
            className="select select-bordered select-sm w-56"
            value={gameId}
            onChange={(e) => setGameId(e.target.value)}
          >
            <option value="">Pick a game...</option>
            {games.map((g) => (
              <option key={g.nba_game_id} value={g.nba_game_id}>
                {g.away_team} @ {g.home_team} ({g.game_date})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold block mb-1" htmlFor="addbet-market">Bet type</label>
          <select
            id="addbet-market"
            className="select select-bordered select-sm"
            value={market}
            onChange={(e) => handleMarketChange(e.target.value as BetMarket)}
          >
            <option value="spread">Spread</option>
            <option value="total">Total</option>
            <option value="moneyline">Moneyline</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold block mb-1" htmlFor="addbet-selection">Side</label>
          <select
            id="addbet-selection"
            className="select select-bordered select-sm w-44"
            value={selection}
            onChange={(e) => setSelection(e.target.value as BetSelection)}
          >
            {selectionChoices.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold block mb-1" htmlFor="addbet-stake">Stake</label>
          <label className="input input-bordered input-sm flex items-center gap-1 w-24">
            $
            <input
              id="addbet-stake"
              type="number"
              min={1}
              value={stake}
              onChange={(e) => setStake(parseFloat(e.target.value) || 0)}
              className="w-full"
            />
          </label>
        </div>
        <button
          onClick={handleSubmit}
          disabled={!game || !resolved || stake <= 0 || saving}
          className="btn btn-primary btn-sm"
        >
          {saving ? 'Adding...' : 'Add bet'}
        </button>
        <button onClick={onDone} className="btn btn-ghost btn-sm">Cancel</button>
      </div>
      {game && !resolved && (
        <p className="text-xs text-warning">That market isn't posted for this game yet.</p>
      )}
      {game && resolved && (
        <p className="text-xs opacity-60">
          Line: {resolved.line != null ? formatLine(resolved.line) : '—'} · Odds: {formatAmerican(resolved.odds)}
        </p>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
};

export const BetLedger = ({ bets, summary, loading, error, games, onTrackBet, onRemoveBet }: BetLedgerProps) => {
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const handleRemove = async (id: number): Promise<void> => {
    setRemovingId(id);
    try {
      await onRemoveBet(id);
    } finally {
      setRemovingId(null);
    }
  };

  const record = `${summary.wins}-${summary.losses}${summary.pushes > 0 ? `-${summary.pushes}` : ''}`;

  return (
    <div className="card bg-base-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-base-300 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <NotebookPen size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">My Bets</h2>
          <span className="text-xs opacity-40 hidden sm:inline">
            paper-trade or log real bets — results settle automatically when games go final
          </span>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn btn-ghost btn-xs">+ Add bet manually</button>
        )}
      </div>

      <div className="p-4 space-y-4">
        {adding && <AddBetForm games={games} onTrackBet={onTrackBet} onDone={() => setAdding(false)} />}

        {loading ? (
          <div className="flex justify-center py-8">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : error ? (
          <p className="text-error text-sm text-center py-4">{error}</p>
        ) : bets.length === 0 ? (
          <p className="text-sm opacity-40 text-center py-6">
            No bets tracked yet. Use "Track this bet" on an AI pick, or add one manually.
          </p>
        ) : (
          <>
            <div className="stats stats-vertical sm:stats-horizontal shadow bg-base-300 w-full">
              <div className="stat py-3">
                <div className="stat-title text-xs">Record</div>
                <div className="stat-value text-lg">{record}</div>
                {summary.pending > 0 && (
                  <div className="stat-desc">{summary.pending} pending</div>
                )}
              </div>
              <div className="stat py-3">
                <div className="stat-title text-xs">Total staked</div>
                <div className="stat-value text-lg">{formatMoney(summary.total_staked)}</div>
              </div>
              <div className="stat py-3">
                <div className="stat-title text-xs">Profit / Loss</div>
                <div className={`stat-value text-lg ${summary.profit > 0 ? 'text-success' : summary.profit < 0 ? 'text-error' : ''}`}>
                  {formatMoney(summary.profit)}
                </div>
              </div>
              <div className="stat py-3">
                <div className="stat-title text-xs">ROI</div>
                <div className={`stat-value text-lg ${summary.roi > 0 ? 'text-success' : summary.roi < 0 ? 'text-error' : ''}`}>
                  {formatPercent(summary.roi)}
                </div>
                <div className="stat-desc">on settled bets</div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Game</th>
                    <th>Bet</th>
                    <th>Odds</th>
                    <th>Stake</th>
                    <th>Status</th>
                    <th>Profit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {bets.map((bet) => (
                    <tr key={bet.id}>
                      <td className="whitespace-nowrap text-xs opacity-60">{bet.game_date}</td>
                      <td className="text-xs">{bet.away_team} @ {bet.home_team}</td>
                      <td className="font-medium text-xs whitespace-nowrap">{betLabel(bet)}</td>
                      <td className="text-xs">{formatAmerican(bet.american_odds)}</td>
                      <td className="text-xs">{formatMoney(bet.stake)}</td>
                      <td>
                        <span className={`badge badge-sm ${STATUS_BADGE[bet.status]}`}>{bet.status}</span>
                      </td>
                      <td className={`text-xs font-medium ${bet.profit > 0 ? 'text-success' : bet.profit < 0 ? 'text-error' : 'opacity-40'}`}>
                        {bet.status === 'pending' ? '—' : formatMoney(bet.profit)}
                      </td>
                      <td>
                        <button
                          onClick={() => handleRemove(bet.id)}
                          disabled={removingId === bet.id}
                          className="btn btn-ghost btn-xs"
                          aria-label={`Delete bet on ${betLabel(bet)}`}
                          title="Delete this bet"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
