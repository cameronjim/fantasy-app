import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { BarChart3, Users, TrendingUp, LogIn, User } from 'lucide-react';
import { changePassword } from '../api/client';

interface NavbarProps {
  isLoggedIn: boolean;
  onLogout: () => void;
}

const tabs = [
  { to: '/', label: 'Stats', icon: BarChart3 },
  { to: '/fantasy', label: 'My Team', icon: Users },
  { to: '/improve', label: 'Improve Team', icon: TrendingUp },
];

function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'At least 8 characters required';
  if (!/[A-Z]/.test(pwd)) return 'Must include at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pwd)) return 'Must include at least one number or symbol';
  return null;
}

export default function Navbar({ isLoggedIn, onLogout }: NavbarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Change password modal stays here — it's a contextual action for already-logged-in
  // users, not a flow that warrants a separate route.
  const [showChangePw, setShowChangePw] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [changePwError, setChangePwError] = useState('');
  const [changePwSuccess, setChangePwSuccess] = useState(false);
  const [changePwLoading, setChangePwLoading] = useState(false);

  const handleChangePw = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setChangePwError('');
    setChangePwSuccess(false);
    const pwErr = validatePassword(newPw);
    if (pwErr) { setChangePwError(pwErr); return; }
    if (newPw !== confirmNewPw) { setChangePwError('New passwords do not match'); return; }
    setChangePwLoading(true);
    try {
      await changePassword(currentPw, newPw);
      setChangePwSuccess(true);
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setChangePwError(msg || 'Failed to update password');
    } finally {
      setChangePwLoading(false);
    }
  };

  const closeChangePw = (): void => {
    setShowChangePw(false);
    setCurrentPw('');
    setNewPw('');
    setConfirmNewPw('');
    setChangePwError('');
    setChangePwSuccess(false);
  };

  const goToSignIn = (): void => {
    // Stash the current path so we can redirect back after a successful sign-in.
    navigate('/login', { state: { from: location.pathname } });
  };

  return (
    <>
      <div className="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4">
        <div className="flex-1">
          <NavLink to="/" className="text-xl font-bold tracking-tight">
            Fantasy<span className="text-primary">NBA</span>
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
                  <button onClick={() => { setShowChangePw(true); (document.activeElement as HTMLElement)?.blur(); }}>
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

      {/* Change Password Modal */}
      {showChangePw && (
        <div className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg mb-4">Change Password</h3>
            {changePwSuccess ? (
              <div className="text-center py-4 space-y-3">
                <p className="text-success font-semibold">Password updated successfully!</p>
                <button onClick={closeChangePw} className="btn btn-primary btn-sm">Done</button>
              </div>
            ) : (
              <form onSubmit={handleChangePw} className="space-y-3">
                <input
                  type="password"
                  placeholder="Current password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  className={`input input-bordered w-full ${changePwError === 'Current password is incorrect' ? 'input-error' : ''}`}
                  autoComplete="current-password"
                  autoFocus
                />
                <div>
                  <input
                    type="password"
                    placeholder="New password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    className="input input-bordered w-full"
                    autoComplete="new-password"
                  />
                  {newPw && (
                    <p className={`text-xs mt-1 px-1 ${validatePassword(newPw) ? 'text-warning' : 'text-success'}`}>
                      {validatePassword(newPw) ?? '✓ Password looks good'}
                    </p>
                  )}
                </div>
                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmNewPw}
                  onChange={(e) => setConfirmNewPw(e.target.value)}
                  className="input input-bordered w-full"
                  autoComplete="new-password"
                />
                <p className="text-xs opacity-40 px-1">Min 8 chars · 1 uppercase · 1 number or symbol</p>
                {changePwError && <p className="text-error text-sm">{changePwError}</p>}
                <div className="modal-action mt-2">
                  <button type="button" onClick={closeChangePw} className="btn btn-ghost">Cancel</button>
                  <button
                    type="submit"
                    disabled={changePwLoading || !currentPw || !newPw || !confirmNewPw}
                    className="btn btn-primary"
                  >
                    {changePwLoading ? <span className="loading loading-spinner loading-sm" /> : 'Update Password'}
                  </button>
                </div>
              </form>
            )}
          </div>
          <div className="modal-backdrop" onClick={closeChangePw} />
        </div>
      )}
    </>
  );
}
