import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { BarChart3, Users, TrendingUp, LogIn, User } from 'lucide-react';

interface NavbarProps {
  isLoggedIn: boolean;
  onLogout: () => void;
}

const tabs = [
  { to: '/', label: 'Stats', icon: BarChart3 },
  { to: '/fantasy', label: 'My Team', icon: Users },
  { to: '/improve', label: 'Improve Team', icon: TrendingUp },
];

export default function Navbar({ isLoggedIn, onLogout }: NavbarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const goToSignIn = (): void => {
    // Stash where we came from so we can redirect back after a successful sign-in.
    navigate('/login', { state: { from: location.pathname } });
  };

  const goToChangePassword = (): void => {
    (document.activeElement as HTMLElement)?.blur();
    navigate('/change-password');
  };

  return (
    <div className="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4">
      <div className="flex-1">
        <NavLink to="/" className="text-xl font-bold tracking-tight">
          Fantasy <span className="text-primary">NBA</span>
        </NavLink>
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
            <ul tabIndex={0} className="dropdown-content menu bg-base-200 rounded-box z-50 w-44 p-2 shadow-lg border border-base-300 mt-1">
              <li>
                <button onClick={goToChangePassword}>
                  Change Password
                </button>
              </li>
              <li>
                <button onClick={onLogout} className="text-error">
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
