import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { getAuthToken, getPreferences, updatePreferences, type AIPreferences } from '../api/client';

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

export const PreferencesPage = () => {
  if (!getAuthToken()) {
    return <Navigate to="/login" replace state={{ from: '/preferences' }} />;
  }

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

  const togglePuntCategory = (cat: string): void => {
    const current = prefs.punt_categories ?? [];
    const next = current.includes(cat)
      ? current.filter((c) => c !== cat)
      : [...current, cat];
    setPrefs({ ...prefs, punt_categories: next });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      const updated = await updatePreferences(prefs);
      setPrefs(updated);
      setSavedAt(Date.now());
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
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={20} className="text-primary" />
        <h1 className="text-2xl font-bold">AI Preferences</h1>
      </div>
      <p className="text-sm opacity-60 mb-6">
        These answers are injected into every AI suggestion (team analysis, waiver picks, chat).
        Update them anytime to get more tailored advice.
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

        <div>
          <label className="text-sm font-semibold block mb-2">
            Are you punting any categories? <span className="text-xs opacity-50 font-normal">(select all you ignore)</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const selected = (prefs.punt_categories ?? []).includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => togglePuntCategory(cat)}
                  className={`btn btn-sm ${selected ? 'btn-error' : 'btn-ghost border border-base-300'}`}
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
            <span className="flex items-center gap-1.5 text-success text-sm">
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
