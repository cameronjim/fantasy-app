import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings, X } from 'lucide-react';
import { getPreferences, getAuthToken } from '../api/client';

const DISMISS_KEY = 'preferences_prompt_dismissed';

/**
 * Subtle banner on /fantasy and /improve that points users to the Team
 * Preferences page when they haven't filled in any answers yet. Auto-hides
 * once any preferences are set, and a small X dismisses it manually.
 */
export const PreferencesPrompt = () => {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    // Skip if not logged in or already dismissed.
    if (!getAuthToken()) return;
    if (localStorage.getItem(DISMISS_KEY) === '1') return;

    getPreferences()
      .then((prefs) => {
        // Show only if there are no meaningful answers yet.
        const hasAny = !!(
          prefs.risk_tolerance ||
          prefs.player_age_pref ||
          prefs.opportunity_chase ||
          prefs.league_format ||
          prefs.roster_strategy ||
          prefs.trade_activity ||
          (prefs.punt_categories && prefs.punt_categories.length > 0) ||
          (prefs.extra_notes && prefs.extra_notes.length > 0)
        );
        setShouldShow(!hasAny);
      })
      .catch(() => { /* silent — non-critical */ });
  }, []);

  if (!shouldShow) return null;

  return (
    <div className="bg-base-200 border border-base-300 rounded-lg px-4 py-3 mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <Settings size={18} className="text-primary opacity-80 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium">Get sharper recommendations</p>
          <p className="text-xs opacity-60">
            Set your team preferences so every suggestion fits your strategy.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Link to="/preferences" className="btn btn-primary btn-sm">
          Set preferences
        </Link>
        <button
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1');
            setShouldShow(false);
          }}
          className="btn btn-ghost btn-sm btn-circle"
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
