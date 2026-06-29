import { useEffect, useState } from 'react';
import { getDataStatus, type DataStatus } from '../api/client';

// Refresh roughly every 5 minutes — the scraper runs every 6 hours, no need to poll fast.
const REFRESH_INTERVAL = 5 * 60_000;

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function fullTimestamp(iso: string | null): string {
  if (!iso) return 'No data yet';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Small badge in the navbar showing how recently the data was scraped.
 * Hover/click to see the per-source breakdown.
 */
export const StatusBadge = () => {
  const [status, setStatus] = useState<DataStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      getDataStatus()
        .then((s) => { if (!cancelled) setStatus(s); })
        .catch(() => { /* silent — badge is non-essential */ });
    };
    load();
    const id = setInterval(load, REFRESH_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // The "freshest" source — for the compact summary in the navbar.
  const mostRecentISO =
    status &&
    [status.players_updated_at, status.teams_updated_at, status.games_updated_at]
      .filter((s): s is string => !!s)
      .sort()
      .reverse()[0];

  return (
    <div className="dropdown dropdown-bottom">
      <button
        tabIndex={0}
        className="btn btn-ghost btn-xs btn-circle"
        aria-label={`Data updated ${relativeTime(mostRecentISO ?? null)}`}
        title={`Data updated ${relativeTime(mostRecentISO ?? null)}`}
      >
        {/* Filled green dot — much more visible than text-success in light mode */}
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
      </button>
      <div tabIndex={0} className="dropdown-content mt-1 z-50 w-60 p-3 shadow-lg bg-base-200 border border-base-300 rounded-box">
        <p className="text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Last updated</p>
        <Row label="Players" iso={status?.players_updated_at ?? null} />
        <Row label="Teams"   iso={status?.teams_updated_at ?? null} />
        <Row label="Games"   iso={status?.games_updated_at ?? null} />
        <p className="text-[10px] opacity-30 mt-2 pt-2 border-t border-base-300">
          Data refreshes every 6 hours
        </p>
      </div>
    </div>
  );
};

const Row = ({ label, iso }: { label: string; iso: string | null }) => (
  <div className="flex items-baseline justify-between py-1">
    <span className="text-xs">{label}</span>
    <span className="text-xs opacity-60" title={fullTimestamp(iso)}>
      {relativeTime(iso)}
    </span>
  </div>
);
