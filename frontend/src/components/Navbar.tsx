import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { BarChart3, Users, TrendingUp, Dices, LogIn, User, Sun, Moon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { StatusBadge } from './StatusBadge';

interface NavbarProps {
  isLoggedIn: boolean;
  onLogout: () => void;
}

const tabs = [
  { to: '/', label: 'Stats', icon: BarChart3 },
  { to: '/fantasy', label: 'My Team', icon: Users },
  { to: '/improve', label: 'Improve Team', icon: TrendingUp },
  { to: '/betting', label: 'Betting', icon: Dices },
];

export function Navbar({ isLoggedIn, onLogout }: NavbarProps): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle: toggleTheme } = useTheme();
  const isDark = theme === 'business';

  const goToSignIn = (): void => {
    navigate('/login', { state: { from: location.pathname } });
  };

  const goAndBlur = (path: string): void => {
    (document.activeElement as HTMLElement)?.blur();
    navigate(path);
  };

  const themeAndBlur = (): void => {
    (document.activeElement as HTMLElement)?.blur();
    toggleTheme();
  };

  // sign-out should always land users on the stats page. without this,
  // signing out from a protected route (e.g. /profile, /fantasy) would
  // either leave them on a now-broken page or bounce them to /login.
  const handleSignOut = (): void => {
    (document.activeElement as HTMLElement)?.blur();
    onLogout();
    navigate('/');
  };

  return (
    <div className="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4">
      <div className="flex-1 flex items-center gap-2">
        <NavLink to="/" className="text-xl font-bold tracking-tight">
          Fantasy <span className="text-primary">NBA</span>
        </NavLink>
        <StatusBadge />
      </div>
      <div className="flex-none gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                `btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`
              }
            >
              <Icon size={16} />
              <span className="hidden sm:inline">{tab.label}</span>
            </NavLink>
          );
        })}

        {isLoggedIn ? (
          <div className="dropdown dropdown-end ml-1">
            <button tabIndex={0} className="btn btn-ghost btn-sm gap-1">
              <User size={16} />
              <span className="hidden sm:inline text-xs">Account</span>
            </button>
            <ul tabIndex={0} className="dropdown-content menu bg-base-200 rounded-box z-50 w-52 p-2 shadow-lg border border-base-300 mt-1">
              <li>
                <button onClick={() => goAndBlur('/profile')}>
                  My Profile
                </button>
              </li>
              <li>
                <button onClick={() => goAndBlur('/preferences')}>
                  Team Preferences
                </button>
              </li>
              <li>
                <button onClick={themeAndBlur} className="flex items-center justify-between">
                  <span>Theme</span>
                  <span className="flex items-center gap-1 opacity-60 text-xs">
                    {isDark ? <Moon size={12} /> : <Sun size={12} />}
                    {isDark ? 'Dark' : 'Light'}
                  </span>
                </button>
              </li>
              <li className="border-t border-base-300 mt-1 pt-1">
                <button onClick={() => goAndBlur('/about')}>
                  About
                </button>
              </li>
              <li>
                <button onClick={handleSignOut} className="text-error">
                  Sign Out
                </button>
              </li>
            </ul>
          </div>
        ) : (
          <>
            {/* Logged-out users still need a way to toggle theme.
                Tiny circle button keeps it from crowding the Sign In CTA. */}
            <button
              onClick={toggleTheme}
              className="btn btn-ghost btn-sm btn-circle"
              aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
              title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button onClick={goToSignIn} className="btn btn-primary btn-sm ml-1 gap-1">
              <LogIn size={16} />
              <span className="hidden sm:inline">Sign In</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
