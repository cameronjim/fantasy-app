import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { formatAmerican, formatLine } from '../utils/formatOdds';
import type { Bet, BettingGame, BetStatus, NewBet, BetMarket, BetSelection, StraightMarket } from '../types';

interface BetLedgerProps {
  bets: Bet[];
  summary: { wins: number; losses: number; pushes: number; pending: number };
  loading: boolean;
  error: string;
  games: BettingGame[];
  onTrackBet: (bet: NewBet) => Promise<void>;
  onSettleBet: (id: number, status: BetStatus) => Promise<void>;
  onRemoveBet: (id: number) => Promise<void>;
}

const STATUS_BADGE: Record<Bet['status'], string> = {
  pending: 'badge-ghost',
  won: 'badge-success',
  lost: 'badge-error',
  push: 'badge-warning',
};

const MARKET_LABEL: Record<BetMarket, string> = {
  spread: 'Spread',
  total: 'Total',
  moneyline: 'Moneyline',
  prop: 'Player prop',
  parlay: 'Parlay',
  custom: 'Custom',
};

// straight bets settle automatically from final scores; everything else is
// graded by the user with the Won/Lost buttons.
const STRAIGHT: BetMarket[] = ['spread', 'total', 'moneyline'];

/** human label for a stored bet, e.g. "Knicks -2.5" or the free-text entry */
function betLabel(bet: Bet): string {
  if (bet.description) return bet.description;
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
  const [market, setMarket] = useState<BetMarket>('spread');
  const [gameId, setGameId] = useState('');
  const [selection, setSelection] = useState<BetSelection>('home');
  const [description, setDescription] = useState('');
  const [oddsText, setOddsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isStraight = STRAIGHT.includes(market);
  const game = games.find((g) => g.nba_game_id === gameId);

  // line/odds come from the posted markets for the chosen game and selection
  // so the user doesn't have to type them; unposted markets are flagged.
  const resolveStraight = (): { line: number | null; odds: number } | null => {
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
  const resolved = isStraight ? resolveStraight() : null;

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
    setError('');
  };

  const parsedOdds = (): number | null => {
    const trimmed = oddsText.trim();
    if (!trimmed) return null;
    const n = parseInt(trimmed, 10);
    return Number.isNaN(n) ? null : n;
  };

  const canSubmit = isStraight
    ? !!game && !!resolved
    : description.trim().length >= 3;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError('');
    try {
      if (isStraight && game && resolved) {
        await onTrackBet({
          market: market as StraightMarket,
          nba_game_id: game.nba_game_id,
          selection,
          line: resolved.line,
          american_odds: resolved.odds,
        });
      } else {
        await onTrackBet({
          market,
          description: description.trim(),
          american_odds: parsedOdds(),
          ...(market === 'prop' && game ? { nba_game_id: game.nba_game_id } : {}),
        });
      }
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
          <label className="text-xs font-semibold block mb-1" htmlFor="addbet-market">Bet type</label>
          <select
            id="addbet-market"
            className="select select-bordered select-sm"
            value={market}
            onChange={(e) => handleMarketChange(e.target.value as BetMarket)}
          >
            {(Object.keys(MARKET_LABEL) as BetMarket[]).map((m) => (
              <option key={m} value={m}>{MARKET_LABEL[m]}</option>
            ))}
          </select>
        </div>

        {(isStraight || market === 'prop') && (
          <div>
            <label className="text-xs font-semibold block mb-1" htmlFor="addbet-game">
              Game{market === 'prop' ? ' (optional)' : ''}
            </label>
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
        )}

        {isStraight && (
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
        )}

        {!isStraight && (
          <div>
            <label className="text-xs font-semibold block mb-1" htmlFor="addbet-odds">Odds (optional)</label>
            <input
              id="addbet-odds"
              type="text"
              placeholder="+600"
              value={oddsText}
              onChange={(e) => setOddsText(e.target.value)}
              className="input input-bordered input-sm w-24"
            />
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canSubmit || saving}
          className="btn btn-primary btn-sm"
        >
          {saving ? 'Adding...' : 'Add bet'}
        </button>
        <button onClick={onDone} className="btn btn-ghost btn-sm">Cancel</button>
      </div>

      {!isStraight && (
        <div>
          <label className="text-xs font-semibold block mb-1" htmlFor="addbet-description">
            {market === 'prop' && 'Describe the prop'}
            {market === 'parlay' && 'List the legs'}
            {market === 'custom' && 'Describe the bet'}
          </label>
          <input
            id="addbet-description"
            type="text"
            maxLength={300}
            placeholder={
              market === 'prop'
                ? 'e.g. "Brunson over 28.5 points"'
                : market === 'parlay'
                  ? 'e.g. "Knicks ML + Under 216.5 + Celtics -3"'
                  : 'e.g. "First basket: Wembanyama (from another sportsbook)"'
            }
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input input-bordered input-sm w-full"
          />
        </div>
      )}

      {isStraight && game && !resolved && (
        <p className="text-xs text-warning">That market isn't posted for this game yet.</p>
      )}
      {isStraight && game && resolved && (
        <p className="text-xs opacity-60">
          Line: {resolved.line != null ? formatLine(resolved.line) : 'n/a'} · Odds: {formatAmerican(resolved.odds)}
        </p>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
};

export const BetLedger = ({ bets, summary, loading, error, games, onTrackBet, onSettleBet, onRemoveBet }: BetLedgerProps) => {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const withBusy = async (id: number, action: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  };

  const record = `${summary.wins}-${summary.losses}${summary.pushes > 0 ? `-${summary.pushes}` : ''}`;

  return (
    <div className="card bg-base-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-base-300 flex items-center justify-between">
        <h2 className="text-sm font-semibold">My Bets</h2>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn btn-ghost btn-xs">+ Add bet</button>
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
            No bets tracked yet. Add spreads, totals, moneylines, props, parlays, or anything custom.
          </p>
        ) : (
          <>
            <div className="stats stats-vertical sm:stats-horizontal shadow bg-base-300 w-full">
              <div className="stat py-3">
                <div className="stat-title text-xs">Record</div>
                <div className="stat-value text-lg">{record}</div>
              </div>
              <div className="stat py-3">
                <div className="stat-title text-xs">Pending</div>
                <div className="stat-value text-lg">{summary.pending}</div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Bet</th>
                    <th>Game</th>
                    <th>Odds</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {bets.map((bet) => {
                    const manual = !STRAIGHT.includes(bet.market);
                    return (
                      <tr key={bet.id}>
                        <td className="whitespace-nowrap text-xs opacity-60">
                          {bet.game_date ?? bet.created_at.slice(0, 10)}
                        </td>
                        <td className="text-xs opacity-60 whitespace-nowrap">{MARKET_LABEL[bet.market]}</td>
                        <td className="font-medium text-xs max-w-60">{betLabel(bet)}</td>
                        <td className="text-xs">
                          {bet.home_team ? `${bet.away_team} @ ${bet.home_team}` : ''}
                        </td>
                        <td className="text-xs">{bet.american_odds != null ? formatAmerican(bet.american_odds) : ''}</td>
                        <td>
                          <span className={`badge badge-sm ${STATUS_BADGE[bet.status]}`}>{bet.status}</span>
                        </td>
                        <td>
                          <div className="flex items-center gap-1 justify-end">
                            {bet.status === 'pending' && manual && (
                              <>
                                <button
                                  onClick={() => withBusy(bet.id, () => onSettleBet(bet.id, 'won'))}
                                  disabled={busyId === bet.id}
                                  className="btn btn-ghost btn-xs text-success"
                                  title="Mark this bet as won"
                                >
                                  Won
                                </button>
                                <button
                                  onClick={() => withBusy(bet.id, () => onSettleBet(bet.id, 'lost'))}
                                  disabled={busyId === bet.id}
                                  className="btn btn-ghost btn-xs text-error"
                                  title="Mark this bet as lost"
                                >
                                  Lost
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => withBusy(bet.id, () => onRemoveBet(bet.id))}
                              disabled={busyId === bet.id}
                              className="btn btn-ghost btn-xs"
                              aria-label={`Delete bet: ${betLabel(bet)}`}
                              title="Delete this bet"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
