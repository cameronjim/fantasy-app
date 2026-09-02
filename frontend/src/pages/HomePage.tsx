import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, CalendarDays, Eye, History, Gamepad2, Users, TrendingUp, Dices } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ScoreboardStrip } from '../components/ScoreboardStrip';
import { getPlayers, getTeams } from '../api/client';
import { prefetchCached, CACHE_KEYS } from '../api/resourceCache';

interface Destination {
  icon: LucideIcon;
  title: string;
  to: string;
  description: string;
  needsAuth: boolean;
}

const destinations: Destination[] = [
  {
    icon: BarChart3,
    title: 'Stats',
    to: '/stats',
    description: 'Per-game averages for every player and team. Sort, filter, and compare.',
    needsAuth: false,
  },
  {
    icon: CalendarDays,
    title: 'Projections',
    to: '/projections',
    description: "Predicted stat lines for tonight's games, ranked by fantasy impact.",
    needsAuth: false,
  },
  {
    icon: Eye,
    title: 'Watchlist',
    to: '/watchlist',
    description: 'Players putting up numbers above their own baseline.',
    needsAuth: false,
  },
  {
    icon: History,
    title: 'History',
    to: '/history',
    description: 'Season-by-season stats from past years.',
    needsAuth: false,
  },
  {
    icon: Gamepad2,
    title: '2K Ratings',
    to: '/ratings',
    description: 'NBA 2K ratings and attribute breakdowns.',
    needsAuth: false,
  },
  {
    icon: Users,
    title: 'My Team',
    to: '/fantasy',
    description: 'Your roster with category averages.',
    needsAuth: true,
  },
  {
    icon: TrendingUp,
    title: 'Improve Team',
    to: '/improve',
    description: "Waiver and trade ideas based on your roster's weak categories.",
    needsAuth: true,
  },
  {
    icon: Dices,
    title: 'Betting',
    to: '/betting',
    description: "Odds, model picks, and the bets you've logged.",
    needsAuth: true,
  },
];

export const HomePage = ({ isLoggedIn }: { isLoggedIn: boolean }) => {
  // this page is meant to be read while the stats caches warm, so fire the
  // prefetch immediately rather than waiting on the app-wide warmup delay.
  useEffect(() => {
    prefetchCached(CACHE_KEYS.players, () => getPlayers());
    prefetchCached(CACHE_KEYS.teams, getTeams);
  }, []);

  return (
    <div>
      <ScoreboardStrip />
      <div className="max-w-[1100px] mx-auto px-4 py-10 space-y-10">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            NBA <span className="text-primary">IQ</span>
          </h1>
          <p className="mt-2 opacity-70">NBA stats, nightly projections, and your fantasy roster.</p>
        </div>

        {!isLoggedIn && (
          <div className="card bg-base-200">
            <div className="card-body flex-row items-center justify-between flex-wrap gap-4">
              <p className="text-sm opacity-80">
                Sign in to track your fantasy roster, get waiver suggestions, and keep a bet ledger.
              </p>
              <Link to="/login" className="btn btn-primary btn-sm">
                Sign in
              </Link>
            </div>
          </div>
        )}

        <div>
          <p className="text-xs uppercase tracking-widest opacity-50 mb-3">Where to start</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {destinations.map((dest) => {
              const Icon = dest.icon;
              return (
                <Link
                  key={dest.to}
                  to={dest.to}
                  className="card bg-base-200 hover:bg-base-300 transition-colors"
                >
                  <div className="card-body">
                    <div className="flex items-center justify-between">
                      <Icon size={20} className="text-primary" />
                      {dest.needsAuth && !isLoggedIn && (
                        <span className="badge badge-ghost badge-sm">Sign in required</span>
                      )}
                    </div>
                    <h2 className="card-title text-base">{dest.title}</h2>
                    <p className="text-sm opacity-70">{dest.description}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        <p className="text-sm opacity-60">
          Stats refresh every six hours. <Link to="/about" className="link link-hover">How this was built</Link>
        </p>
      </div>
    </div>
  );
};
