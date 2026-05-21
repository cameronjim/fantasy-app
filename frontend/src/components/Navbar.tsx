import { useState } from 'react';
import { BarChart3, Users, TrendingUp, LogOut, LogIn } from 'lucide-react';
import { login } from '../api/client';

interface NavbarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  isLoggedIn: boolean;
  onLogout: () => void;
  onLoginSuccess: () => void;
}

const TABS: { id: string; label: string; icon: typeof BarChart3 }[] = [
  { id: 'stats', label: 'Stats', icon: BarChart3 },
  { id: 'fantasy', label: 'My Team', icon: Users },
  { id: 'improve', label: 'Improve', icon: TrendingUp },
];

export const Navbar = ({ activeTab, onTabChange, isLoggedIn, onLogout, onLoginSuccess }: NavbarProps) => {
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      setShowLogin(false);
      setPassword('');
      onLoginSuccess();
    } catch {
      setError('Incorrect password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4">
        <div className="flex-1">
          <span className="text-xl font-bold">
            Fantasy<span className="text-primary ml-[4px]">NBA</span>
          </span>
        </div>
        <div className="flex-none gap-1">
          {TABS.map((tab) => {
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
            <button onClick={() => setShowLogin(true)} className="btn btn-ghost btn-sm ml-1">
              <LogIn size={16} />
              <span className="hidden sm:inline">Sign In</span>
            </button>
          )}
        </div>
      </div>

      {showLogin && (
        <div className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg mb-4">Sign In</h3>
            <form onSubmit={handleLogin} className="space-y-4">
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input input-bordered w-full"
                autoFocus
              />
              {error && <p className="text-error text-sm">{error}</p>}
              <div className="modal-action mt-4">
                <button type="button" onClick={() => { setShowLogin(false); setPassword(''); setError(''); }} className="btn btn-ghost">
                  Cancel
                </button>
                <button type="submit" disabled={loading || !password} className="btn btn-primary">
                  {loading ? <span className="loading loading-spinner loading-sm" /> : 'Sign In'}
                </button>
              </div>
            </form>
          </div>
          <div className="modal-backdrop" onClick={() => { setShowLogin(false); setPassword(''); setError(''); }} />
        </div>
      )}
    </>
  );
};
