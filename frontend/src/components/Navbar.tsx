import { useState } from 'react';
import { BarChart3, Users, TrendingUp, LogOut, LogIn } from 'lucide-react';
import { login, register } from '../api/client';

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

export default function Navbar({ activeTab, onTabChange, isLoggedIn, onLogout, onLoginSuccess }: NavbarProps) {
  const [showModal, setShowModal] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'register') {
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
      if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
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
            <button onClick={onLogout} className="btn btn-ghost btn-sm ml-1" title="Sign out">
              <LogOut size={16} />
            </button>
          ) : (
            <button onClick={() => { setMode('login'); setShowModal(true); }} className="btn btn-primary btn-sm ml-1 gap-1">
              <LogIn size={16} />
              <span className="hidden sm:inline">Sign In</span>
            </button>
          )}
        </div>
      </div>

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
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`input input-bordered w-full ${error ? 'input-error' : ''}`}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
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
              {error && <p className="text-error text-sm">{error}</p>}
              <div className="modal-action mt-2">
                <button type="button" onClick={closeModal} className="btn btn-ghost">Cancel</button>
                <button
                  type="submit"
                  disabled={loading || !username || !password || (mode === 'register' && !confirmPassword)}
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
    </>
  );
}
