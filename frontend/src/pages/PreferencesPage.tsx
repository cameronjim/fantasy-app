import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { getAuthToken, getPreferences, updatePreferences, type AIPreferences } from '../api/client';
import { invalidateAIClientCaches } from '../api/clientCaches';

const CATEGORIES = ['PTS', 'REB', 'AST', 'STL', 'BLK', 'FG%', 'FT%', '3PM', 'TO'];

interface Choice<T extends string> {
  value: T;
  label: string;
  description: string;
}

const RISK_CHOICES: Choice<NonNullable<AIPreferences['risk_tolerance']>>[] = [
  { value: 'avoid_injured', label: 'Avoid injury-prone', description: 'Reliability over ceiling. Skip players with frequent IR stints.' },
  { value: 'balanced',      label: 'Balanced',          description: 'Moderate risk for proportional upside.' },
  { value: 'high_upside',   label: 'Chase upside',      description: 'Roster injury-prone stars for their ceiling.' },
];

const AGE_CHOICES: Choice<NonNullable<AIPreferences['player_age_pref']>>[] = [
  { value: 'veterans',     label: 'Veterans',           description: 'Established players with consistent production.' },
  { value: 'balanced',     label: 'Mix',                description: 'No strong preference.' },
  { value: 'young_upside', label: 'Young upside',       description: 'Favor breakouts and high-ceiling rookies/sophomores.' },
];

const OPPORTUNITY_CHOICES: Choice<NonNullable<AIPreferences['opportunity_chase']>>[] = [
  { value: 'yes', label: 'Yes',  description: 'Target players when teammates are out. More minutes = more stats.' },
  { value: 'no',  label: 'No',   description: 'Recommend players with sustainable, long-term roles.' },
];

const LEAGUE_CHOICES: Choice<NonNullable<AIPreferences['league_format']>>[] = [
  { value: 'h2h_categories', label: 'H2H Categories', description: 'Weekly wins/losses across each of 9 cats.' },
  { value: 'h2h_points',     label: 'H2H Points',     description: 'Weekly fantasy point totals.' },
  { value: 'roto',           label: 'Roto',           description: 'Cumulative season-long standings.' },
  { value: 'points',         label: 'Season points',  description: 'Season-long points league.' },
];

const ROSTER_CHOICES: Choice<NonNullable<AIPreferences['roster_strategy']>>[] = [
  { value: 'stars_scrubs', label: 'Stars and scrubs', description: 'Concentrate value in a few elite players.' },
  { value: 'balanced',     label: 'Balanced',         description: 'Spread quality across the lineup.' },
  { value: 'streaming',    label: 'Streaming',        description: 'Actively swap bench/utility for matchup volume.' },
];

const TRADE_CHOICES: Choice<NonNullable<AIPreferences['trade_activity']>>[] = [
  { value: 'active',     label: 'Active trader',     description: 'Open to frequent buy-low/sell-high moves.' },
  { value: 'occasional', label: 'Occasional',        description: 'Trades when value is clear.' },
  { value: 'set_forget', label: 'Set and forget',    description: 'Avoid trade suggestions unless huge upside.' },
];

const SCHEDULE_CHOICES: Choice<NonNullable<AIPreferences['schedule_weight']>>[] = [
  { value: 'matters_a_lot', label: 'Matters a lot',    description: 'Heavily favor 4-game weeks and good matchups.' },
  { value: 'somewhat',      label: 'Somewhat',         description: 'Consider schedule but talent comes first.' },
  { value: 'ignore',        label: 'Ignore it',        description: 'Talent and role only. Schedule evens out.' },
];

const ROOKIE_CHOICES: Choice<NonNullable<AIPreferences['rookie_hunger']>>[] = [
  { value: 'love_them', label: 'Love them',     description: 'Surface rookies and breakouts aggressively.' },
  { value: 'mixed',     label: 'Selectively',   description: 'Open if the upside is real.' },
  { value: 'avoid',     label: 'Avoid',         description: 'Only proven, established producers.' },
];

const PLAYOFF_CHOICES: Choice<NonNullable<AIPreferences['playoff_focus']>>[] = [
  { value: 'yes', label: 'Yes',  description: 'Weight toward players healthy/producing in late-season weeks.' },
  { value: 'no',  label: 'No',   description: 'Optimize for season-long performance.' },
];

const BENCH_CHOICES: Choice<NonNullable<AIPreferences['bench_philosophy']>>[] = [
  { value: 'high_upside_stash',  label: 'Upside stashes',     description: 'High-ceiling speculative picks, injured-star stashes.' },
  { value: 'safe_role_players',  label: 'Safe role players',  description: 'Reliable nightly contributors, minimal volatility.' },
  { value: 'streaming_slots',    label: 'Streaming slots',    description: 'Keep slots open for daily/weekly streaming.' },
];

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

export const PreferencesPage = () => {
  const [prefs, setPrefs] = useState<AIPreferences>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getPreferences()
      .then(setPrefs)
      .catch(() => setError('Failed to load preferences'))
      .finally(() => setLoading(false));
  }, []);

  // the auth guard must come AFTER every hook: an early return above a hook
  // crashes with react error #300 when the token disappears while the page
  // is mounted (e.g. signing out from this page).
  if (!getAuthToken()) {
    return <Navigate to="/login" replace state={{ from: '/preferences' }} />;
  }

  const togglePuntCategory = (cat: string): void => {
    const current = prefs.punt_categories ?? [];
    const next = current.includes(cat)
      ? current.filter((c) => c !== cat)
      : [...current, cat];
    setPrefs({ ...prefs, punt_categories: next });
  };

  const togglePriorityCategory = (cat: string): void => {
    const current = prefs.priority_categories ?? [];
    const next = current.includes(cat)
      ? current.filter((c) => c !== cat)
      : [...current, cat];
    setPrefs({ ...prefs, priority_categories: next });
  };

  const togglePosition = (pos: string): void => {
    const current = prefs.position_needs ?? [];
    const next = current.includes(pos)
      ? current.filter((p) => p !== pos)
      : [...current, pos];
    setPrefs({ ...prefs, position_needs: next });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      const updated = await updatePreferences(prefs);
      setPrefs(updated);
      setSavedAt(Date.now());
      // Prefs are part of the server's AI cache key — wipe local caches so
      // /fantasy and /improve re-fetch with the new prompt next visit.
      invalidateAIClientCaches();
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-24">
      <h1 className="text-2xl font-bold mb-2">Team Preferences</h1>
      <p className="text-sm opacity-60 mb-6">
        Tell us about your fantasy strategy and we'll tailor every suggestion to fit. Update these anytime.
      </p>

      <div className="space-y-5">
        <Question
          label="How do you feel about injury-prone players?"
          choices={RISK_CHOICES}
          value={prefs.risk_tolerance}
          onChange={(v) => setPrefs({ ...prefs, risk_tolerance: v })}
        />

        <Question
          label="Veterans vs. young players?"
          choices={AGE_CHOICES}
          value={prefs.player_age_pref}
          onChange={(v) => setPrefs({ ...prefs, player_age_pref: v })}
        />

        <Question
          label="Target players whose teammates are injured (for extra minutes)?"
          choices={OPPORTUNITY_CHOICES}
          value={prefs.opportunity_chase}
          onChange={(v) => setPrefs({ ...prefs, opportunity_chase: v })}
        />

        <Question
          label="What's your league format?"
          choices={LEAGUE_CHOICES}
          value={prefs.league_format}
          onChange={(v) => setPrefs({ ...prefs, league_format: v })}
        />

        <div>
          <label className="text-sm font-semibold block mb-2">
            How many teams in your league?
            <span className="text-xs opacity-50 font-normal ml-2">
              (helps us calibrate waiver-wire suggestions)
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            {[8, 10, 12, 14, 16].map((size) => {
              const selected = prefs.league_size === size;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => setPrefs({ ...prefs, league_size: size })}
                  className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                >
                  {size} teams
                </button>
              );
            })}
            <input
              type="number"
              min={4}
              max={20}
              value={prefs.league_size && ![8, 10, 12, 14, 16].includes(prefs.league_size) ? prefs.league_size : ''}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isNaN(n)) {
                  setPrefs({ ...prefs, league_size: undefined });
                } else {
                  setPrefs({ ...prefs, league_size: Math.max(4, Math.min(20, n)) });
                }
              }}
              placeholder="Other"
              className="input input-bordered input-sm w-24"
            />
          </div>
        </div>

        <Question
          label="Roster construction strategy?"
          choices={ROSTER_CHOICES}
          value={prefs.roster_strategy}
          onChange={(v) => setPrefs({ ...prefs, roster_strategy: v })}
        />

        <Question
          label="How active are you with trades?"
          choices={TRADE_CHOICES}
          value={prefs.trade_activity}
          onChange={(v) => setPrefs({ ...prefs, trade_activity: v })}
        />

        <Question
          label="How much does the weekly schedule matter?"
          choices={SCHEDULE_CHOICES}
          value={prefs.schedule_weight}
          onChange={(v) => setPrefs({ ...prefs, schedule_weight: v })}
        />

        <Question
          label="How do you feel about rookies and breakouts?"
          choices={ROOKIE_CHOICES}
          value={prefs.rookie_hunger}
          onChange={(v) => setPrefs({ ...prefs, rookie_hunger: v })}
        />

        <Question
          label="Are you planning for fantasy playoffs?"
          choices={PLAYOFF_CHOICES}
          value={prefs.playoff_focus}
          onChange={(v) => setPrefs({ ...prefs, playoff_focus: v })}
        />

        <Question
          label="Bench philosophy?"
          choices={BENCH_CHOICES}
          value={prefs.bench_philosophy}
          onChange={(v) => setPrefs({ ...prefs, bench_philosophy: v })}
        />

        <div>
          <label className="text-sm font-semibold block mb-2">
            Do you have roster needs at any positions? <span className="text-xs opacity-50 font-normal">(select all that apply)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {POSITIONS.map((pos) => {
              const selected = (prefs.position_needs ?? []).includes(pos);
              return (
                <button
                  key={pos}
                  onClick={() => togglePosition(pos)}
                  className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                >
                  {pos}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-semibold block mb-2">
            Priority categories <span className="text-xs opacity-50 font-normal">(must be strengths)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const selected = (prefs.priority_categories ?? []).includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => togglePriorityCategory(cat)}
                  className={`btn btn-sm ${selected ? 'btn-success text-white' : 'btn-ghost border border-base-300'}`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-semibold block mb-2">
            Punt categories <span className="text-xs opacity-50 font-normal">(ignore these entirely)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const selected = (prefs.punt_categories ?? []).includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => togglePuntCategory(cat)}
                  className={`btn btn-sm ${selected ? 'btn-error text-white' : 'btn-ghost border border-base-300'}`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-semibold block mb-2">
            Anything else the AI should know? <span className="text-xs opacity-50 font-normal">(optional, max 1000 chars)</span>
          </label>
          <textarea
            value={prefs.extra_notes ?? ''}
            onChange={(e) => setPrefs({ ...prefs, extra_notes: e.target.value.slice(0, 1000) })}
            placeholder="e.g. 'I have an empty IR slot' or 'My league has dynasty keepers' or 'I need 3PM badly this week'"
            className="textarea textarea-bordered w-full"
            rows={3}
          />
          <p className="text-xs opacity-40 mt-1">{(prefs.extra_notes ?? '').length}/1000</p>
        </div>
      </div>

      <div className="sticky bottom-0 mt-8 -mx-4 px-4 py-3 bg-base-100/95 backdrop-blur border-t border-base-300 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="badge badge-success gap-1.5 px-3 py-3 text-sm font-semibold text-white">
              <CheckCircle2 size={16} />
              Saved
            </span>
          )}
          {error && <span className="text-error text-sm">{error}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Link to="/" className="btn btn-ghost btn-sm">Done</Link>
          <button onClick={handleSave} disabled={saving} className="btn btn-primary btn-sm">
            {saving ? <span className="loading loading-spinner loading-sm" /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface QuestionProps<T extends string> {
  label: string;
  choices: Choice<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
}

function Question<T extends string>({ label, choices, value, onChange }: QuestionProps<T>) {
  return (
    <div>
      <label className="text-sm font-semibold block mb-2">{label}</label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {choices.map((c) => (
          <button
            key={c.value}
            onClick={() => onChange(c.value)}
            className={`text-left p-3 rounded-lg border transition ${
              value === c.value
                ? 'border-primary bg-primary/10'
                : 'border-base-300 hover:border-base-content/30'
            }`}
          >
            <div className="text-sm font-semibold mb-0.5">{c.label}</div>
            <div className="text-xs opacity-60 leading-snug">{c.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
