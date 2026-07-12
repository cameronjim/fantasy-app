import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { getPreferences, updatePreferences, type BettingPreferences } from '../api/client';
import { invalidateBettingClientCache } from '../api/clientCaches';

interface BettingPrefsPanelProps {
  // called after a successful save so the page can re-run the AI analysis
  // with the new preferences.
  onSaved: (prefs: BettingPreferences) => void;
}

const RISK_CHOICES = [
  { value: 'conservative', label: 'Conservative', description: 'Safer picks, smaller swings' },
  { value: 'balanced', label: 'Balanced', description: 'A mix of safe and value plays' },
  { value: 'aggressive', label: 'Aggressive', description: 'More longshots and plus-money picks' },
] as const;

const MARKET_CHOICES = [
  { value: 'spread', label: 'Spreads' },
  { value: 'total', label: 'Totals (over/under)' },
  { value: 'moneyline', label: 'Moneylines' },
  { value: 'parlay', label: 'Parlays' },
] as const;

/**
 * Inline, collapsible betting preferences. Lives on the betting page (not a
 * separate questionnaire) so the change → re-analyze loop is immediate.
 */
export const BettingPrefsPanel = ({ onSaved }: BettingPrefsPanelProps) => {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<BettingPreferences>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getPreferences()
      .then((all) => setPrefs(all.betting ?? {}))
      .catch(() => { /* silent — panel just starts blank */ })
      .finally(() => setLoading(false));
  }, []);

  const toggleMarket = (market: NonNullable<BettingPreferences['preferred_markets']>[number]): void => {
    const current = prefs.preferred_markets ?? [];
    const next = current.includes(market)
      ? current.filter((m) => m !== market)
      : [...current, market];
    setPrefs({ ...prefs, preferred_markets: next });
  };

  const handleNumber = (key: 'bankroll' | 'unit_size', value: string): void => {
    const n = parseFloat(value);
    setPrefs({ ...prefs, [key]: Number.isNaN(n) ? undefined : n });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      const updated = await updatePreferences({ betting: prefs });
      setPrefs(updated.betting ?? {});
      // prefs are part of the server's picks cache key — wipe the local cache
      // and let the page kick off a fresh analysis.
      invalidateBettingClientCache();
      onSaved(updated.betting ?? {});
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card bg-base-200">
      <button
        onClick={() => setOpen(!open)}
        className="px-4 py-3 flex items-center justify-between w-full text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <SlidersHorizontal size={16} className="text-primary" />
          Betting Preferences
          <span className="text-xs opacity-40 font-normal hidden sm:inline">
            risk, bet types, bankroll — picks are tailored to these
          </span>
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-base-300 pt-4">
          {loading ? (
            <div className="flex justify-center py-4">
              <span className="loading loading-spinner loading-sm" />
            </div>
          ) : (
            <>
              <div>
                <span className="text-xs font-semibold block mb-2">Risk appetite</span>
                <div className="flex flex-wrap gap-2">
                  {RISK_CHOICES.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      onClick={() => setPrefs({ ...prefs, risk_appetite: choice.value })}
                      className={`btn btn-sm ${prefs.risk_appetite === choice.value ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                      title={choice.description}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-xs font-semibold block mb-2">Bet types you're interested in</span>
                <div className="flex flex-wrap gap-3">
                  {MARKET_CHOICES.map((choice) => (
                    <label key={choice.value} className="flex items-center gap-1.5 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-xs"
                        checked={(prefs.preferred_markets ?? []).includes(choice.value)}
                        onChange={() => toggleMarket(choice.value)}
                      />
                      {choice.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="text-xs font-semibold block mb-1" htmlFor="betting-bankroll">
                    Bankroll
                    <span className="opacity-50 font-normal ml-1">(money you're playing with — enables stake sizing)</span>
                  </label>
                  <label className="input input-bordered input-sm flex items-center gap-1 w-36">
                    $
                    <input
                      id="betting-bankroll"
                      type="number"
                      min={1}
                      value={prefs.bankroll ?? ''}
                      onChange={(e) => handleNumber('bankroll', e.target.value)}
                      className="w-full"
                      placeholder="500"
                    />
                  </label>
                </div>
                <div>
                  <label className="text-xs font-semibold block mb-1" htmlFor="betting-unit">
                    Typical bet size
                    <span className="opacity-50 font-normal ml-1">(your default stake)</span>
                  </label>
                  <label className="input input-bordered input-sm flex items-center gap-1 w-36">
                    $
                    <input
                      id="betting-unit"
                      type="number"
                      min={1}
                      value={prefs.unit_size ?? ''}
                      onChange={(e) => handleNumber('unit_size', e.target.value)}
                      className="w-full"
                      placeholder="10"
                    />
                  </label>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold block mb-1" htmlFor="betting-notes">
                  Anything else the AI should know?
                </label>
                <textarea
                  id="betting-notes"
                  className="textarea textarea-bordered w-full text-sm"
                  rows={2}
                  maxLength={1000}
                  placeholder={'e.g. "I like unders", "never bet against my Knicks", "only suggest underdogs"'}
                  value={prefs.extra_notes ?? ''}
                  onChange={(e) => setPrefs({ ...prefs, extra_notes: e.target.value })}
                />
              </div>

              <div className="flex items-center gap-3">
                <button onClick={handleSave} disabled={saving} className="btn btn-primary btn-sm">
                  {saving ? 'Saving...' : 'Save & Re-analyze'}
                </button>
                {error && <span className="text-xs text-error">{error}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
