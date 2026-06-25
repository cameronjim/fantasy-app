import { useState } from 'react';
import { BarChart3, Users, TrendingUp, LogIn, User } from 'lucide-react';
import { login, register, changePassword } from '../api/client';

interface NavbarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  isLoggedIn: boolean;
  onLogout: () => void;
  onLoginSuccess: () => void;
}

const tabs = [
  { id: 'stats', label: 'Stats', icon: BarChart3 },
  { id: 'fantasy', label: 'My Team', icon: Users },
  { id: 'improve', label: 'Improve Team', icon: TrendingUp },
];

function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'At least 8 characters required';
  if (!/[A-Z]/.test(pwd)) return 'Must include at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pwd)) return 'Must include at least one number or symbol';
  return null;
}

export default function Navbar({ activeTab, onTabChange, isLoggedIn, onLogout, onLoginSuccess }: NavbarProps) {
  // Sign in / register modal
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Change password modal
  const [showChangePw, setShowChangePw] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [changePwError, setChangePwError] = useState('');
  const [changePwSuccess, setChangePwSuccess] = useState(false);
  const [changePwLoading, setChangePwLoading] = useState(false);

  const pwValidationError = mode === 'register' ? validatePassword(password) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'register') {
      const pwErr = validatePassword(password);
      if (pwErr) { setError(pwErr); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, password);
      }
      onLoginSuccess();
      closeModal();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setUsername('');
    setPassword('');
    setConfirmPassword('');
    setError('');
  };

  const switchMode = (m: 'login' | 'register') => {
    setMode(m);
    setUsername('');
    setPassword('');
    setConfirmPassword('');
    setError('');
  };

  const handleChangePw = async (e: React.FormEvent) => {
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

  const closeChangePw = () => {
    setShowChangePw(false);
    setCurrentPw('');
    setNewPw('');
    setConfirmNewPw('');
    setChangePwError('');
    setChangePwSuccess(false);
  };

  return (
    <>
      <div className="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4">
        <div className="flex-1">
          <span className="text-xl font-bold tracking-tight">
            Fantasy<span className="text-primary">NBA</span>
          </span>
        </div>
        <div className="flex-none gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-ghost'}`}
              >
                <Icon size={16} />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
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
            <button onClick={() => { setMode('login'); setShowModal(true); }} className="btn btn-primary btn-sm ml-1 gap-1">
              <LogIn size={16} />
              <span className="hidden sm:inline">Sign In</span>
            </button>
          )}
        </div>
      </div>

      {/* Sign In / Register Modal */}
      {showModal && (
        <div className="modal modal-open">
          <div className="modal-box max-w-sm">
            <div className="tabs tabs-boxed mb-5">
              <button className={`tab flex-1 ${mode === 'login' ? 'tab-active' : ''}`} onClick={() => switchMode('login')}>
                Sign In
              </button>
              <button className={`tab flex-1 ${mode === 'register' ? 'tab-active' : ''}`} onClick={() => switchMode('register')}>
                Create Account
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={`input input-bordered w-full ${error ? 'input-error' : ''}`}
                autoFocus
                autoComplete="username"
              />
              <div>
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`input input-bordered w-full ${error ? 'input-error' : ''}`}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                {mode === 'register' && (
                  <p className={`text-xs mt-1 px-1 ${pwValidationError ? 'text-warning' : 'text-success'}`}>
                    {pwValidationError ?? '✓ Password looks good'}
                  </p>
                )}
              </div>
              {mode === 'register' && (
                <input
                  type="password"
                  placeholder="Confirm password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`input input-bordered w-full ${error ? 'input-error' : ''}`}
                  autoComplete="new-password"
                />
              )}
              {mode === 'register' && (
                <p className="text-xs opacity-40 px-1">
                  Min 8 chars · 1 uppercase · 1 number or symbol
                </p>
              )}
              {error && <p className="text-error text-sm">{error}</p>}
              <div className="modal-action mt-2">
                <button type="button" onClick={closeModal} className="btn btn-ghost">Cancel</button>
                <button
                  type="submit"
                  disabled={loading || !username || !password || (mode === 'register' && (!confirmPassword || !!pwValidationError))}
                  className="btn btn-primary"
                >
                  {loading
                    ? <span className="loading loading-spinner loading-sm" />
                    : mode === 'login' ? 'Sign In' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
          <div className="modal-backdrop" onClick={closeModal} />
        </div>
      )}

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
