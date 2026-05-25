import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { User, KeyRound, CheckCircle2 } from 'lucide-react';
import {
  changePassword,
  getAuthToken,
  getCurrentUser,
  updateProfile,
  type CurrentUser,
} from '../api/client';

type TabKey = 'profile' | 'password';

const TABS: Array<{ key: TabKey; label: string; icon: typeof User }> = [
  { key: 'profile', label: 'My Profile', icon: User },
  { key: 'password', label: 'Change Password', icon: KeyRound },
];

export const ProfilePage = () => {
  const navigate = useNavigate();
  const location = useLocation();

  if (!getAuthToken()) {
    return <Navigate to="/login" replace state={{ from: '/profile' }} />;
  }

  // remember the active tab in the url hash so refreshes stay put.
  const initialTab: TabKey =
    location.hash === '#password' ? 'password' : 'profile';
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

  const switchTab = (key: TabKey): void => {
    setActiveTab(key);
    navigate(`/profile${key === 'profile' ? '' : `#${key}`}`, { replace: true });
  };

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-5">Account</h1>
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-5">
        <nav className="card bg-base-200 p-2 h-fit">
          <ul className="menu menu-sm w-full">
            {TABS.map(({ key, label, icon: Icon }) => (
              <li key={key}>
                <button
                  onClick={() => switchTab(key)}
                  className={activeTab === key ? 'menu-active' : ''}
                >
                  <Icon size={16} />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="card bg-base-200">
          <div className="card-body">
            {activeTab === 'profile' && <MyProfilePanel />}
            {activeTab === 'password' && <ChangePasswordPanel />}
          </div>
        </section>
      </div>
    </div>
  );
};

const MyProfilePanel = () => {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    getCurrentUser()
      .then((u) => {
        setUser(u);
        setName(u.name ?? '');
        setEmail(u.email ?? '');
        setPhone(u.phone ?? '');
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const dirty =
    !!user &&
    (name !== (user.name ?? '') ||
      email !== (user.email ?? '') ||
      phone !== (user.phone ?? ''));

  const handleSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setError('');
    try {
      const updated = await updateProfile({
        name: name === (user.name ?? '') ? undefined : name,
        email: email === (user.email ?? '') ? undefined : email,
        phone: phone === (user.phone ?? '') ? undefined : phone,
      });
      setUser(updated);
      setSavedAt(Date.now());
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }

  return (
    <>
      <h2 className="card-title text-lg mb-1">My Profile</h2>
      <p className="text-sm opacity-50 mb-4">
        These fields are for your records. Email is used for password resets.
      </p>

      <form onSubmit={handleSave} className="space-y-4 max-w-md">
        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">Username</label>
          <input
            type="text"
            value={user?.username ?? ''}
            readOnly
            className="input input-bordered w-full opacity-70 cursor-not-allowed"
          />
          <p className="text-xs opacity-40 mt-1">Usernames can't be changed.</p>
        </div>

        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input input-bordered w-full"
            maxLength={100}
            placeholder="Your name"
          />
        </div>

        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input input-bordered w-full"
            autoComplete="email"
          />
        </div>

        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="input input-bordered w-full"
            autoComplete="tel"
            placeholder="(555) 555-5555"
          />
        </div>

        {error && <p className="text-error text-sm">{error}</p>}
        {savedAt && !error && (
          <p className="text-success text-sm flex items-center gap-1.5">
            <CheckCircle2 size={14} /> Saved
          </p>
        )}

        <button
          type="submit"
          disabled={saving || !dirty}
          className="btn btn-primary"
        >
          {saving ? <span className="loading loading-spinner loading-sm" /> : 'Save changes'}
        </button>
      </form>
    </>
  );
};

const ChangePasswordPanel = () => {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const pwValidationError = newPw ? validatePassword(newPw) : null;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    const pwErr = validatePassword(newPw);
    if (pwErr) {
      setError(pwErr);
      return;
    }
    if (newPw !== confirmNewPw) {
      setError('New passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await changePassword(currentPw, newPw);
      setSuccess(true);
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Failed to update password');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="text-center py-8">
        <div className="flex justify-center mb-3">
          <div className="bg-success/15 text-success rounded-full p-3">
            <CheckCircle2 size={28} />
          </div>
        </div>
        <h2 className="card-title justify-center text-xl mb-2">Password updated</h2>
        <p className="text-sm opacity-60 mb-4">
          Your password has been changed successfully.
        </p>
        <button onClick={() => setSuccess(false)} className="btn btn-ghost btn-sm">
          Change another password
        </button>
      </div>
    );
  }

  return (
    <>
      <h2 className="card-title text-lg mb-1">Change Password</h2>
      <p className="text-sm opacity-50 mb-4">Update the password on your account.</p>

      <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">Current password</label>
          <input
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            className={`input input-bordered w-full ${error === 'Current password is incorrect' ? 'input-error' : ''}`}
            autoComplete="current-password"
          />
        </div>

        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">New password</label>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            className="input input-bordered w-full"
            autoComplete="new-password"
          />
          {newPw && (
            <p
              className={`text-xs mt-1 px-1 ${
                pwValidationError ? 'text-warning' : 'text-success'
              }`}
            >
              {pwValidationError ?? '✓ Password looks good'}
            </p>
          )}
        </div>

        <div>
          <label className="text-xs font-medium opacity-60 mb-1 block">Confirm new password</label>
          <input
            type="password"
            value={confirmNewPw}
            onChange={(e) => setConfirmNewPw(e.target.value)}
            className="input input-bordered w-full"
            autoComplete="new-password"
          />
        </div>

        <p className="text-xs opacity-40 px-1">
          Min 8 chars · 1 uppercase · 1 number or symbol
        </p>

        {error && <p className="text-error text-sm">{error}</p>}

        <button
          type="submit"
          disabled={
            loading || !currentPw || !newPw || !confirmNewPw || !!pwValidationError
          }
          className="btn btn-primary"
        >
          {loading ? <span className="loading loading-spinner loading-sm" /> : 'Update password'}
        </button>
      </form>
    </>
  );
};

function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'At least 8 characters required';
  if (!/[A-Z]/.test(pwd)) return 'Must include at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pwd)) {
    return 'Must include at least one number or symbol';
  }
  return null;
}
