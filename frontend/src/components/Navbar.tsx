import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { BarChart3, History, Gamepad2, Users, TrendingUp, Dices, LogIn, User } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { ThemePicker } from './ThemePicker';
import { getCurrentUser } from '../api/client';

interface NavbarProps {
  isLoggedIn: boolean;
  onLogout: () => void;
}

const tabs = [
  { to: '/', label: 'Stats', icon: BarChart3 },
  { to: '/history', label: 'History', icon: History },
  { to: '/ratings', label: '2K Ratings', icon: Gamepad2 },
  { to: '/fantasy', label: 'My Team', icon: Users },
  { to: '/improve', label: 'Improve Team', icon: TrendingUp },
  { to: '/betting', label: 'Betting', icon: Dices },
];

export function Navbar({ isLoggedIn, onLogout }: NavbarProps): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(false);

  // the flag only gates the nav link — the admin api re-checks server-side,
  // so a failed lookup just hides the shortcut.
  useEffect(() => {
    if (!isLoggedIn) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (!cancelled) setIsAdmin(user.is_admin);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn]);

  const goToSignIn = (): void => {
    navigate('/login', { state: { from: location.pathname } });
  };

  const goAndBlur = (path: string): void => {
    (document.activeElement as HTMLElement)?.blur();
    navigate(path);
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

        {/* theme picker is always visible, signed in or out. */}
        <ThemePicker />

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
              {isAdmin && (
                <li className="border-t border-base-300 mt-1 pt-1">
                  <button onClick={() => goAndBlur('/admin')}>
                    Developer Tools
                  </button>
                </li>
              )}
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
          <button onClick={goToSignIn} className="btn btn-primary btn-sm ml-1 gap-1">
            <LogIn size={16} />
            <span className="hidden sm:inline">Sign In</span>
          </button>
        )}
      </div>
    </div>
  );
}
