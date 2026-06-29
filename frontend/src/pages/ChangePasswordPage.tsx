import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { changePassword, getAuthToken } from '../api/client';

function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'At least 8 characters required';
  if (!/[A-Z]/.test(pwd)) return 'Must include at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pwd)) return 'Must include at least one number or symbol';
  return null;
}

export const ChangePasswordPage = () => {
  const navigate = useNavigate();

  // Gate behind auth — bounce to /login if not signed in.
  if (!getAuthToken()) {
    return <Navigate to="/login" replace state={{ from: '/change-password' }} />;
  }

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
    if (pwErr) { setError(pwErr); return; }
    if (newPw !== confirmNewPw) { setError('New passwords do not match'); return; }

    setLoading(true);
    try {
      await changePassword(currentPw, newPw);
      setSuccess(true);
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to update password');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
        <div className="card bg-base-200 w-full max-w-sm shadow-xl">
          <div className="card-body">
            <div className="flex justify-center mb-3">
              <div className="bg-success/15 text-success rounded-full p-3">
                <CheckCircle2 size={28} />
              </div>
            </div>
            <h2 className="card-title justify-center text-xl mb-2">Password updated</h2>
            <p className="text-sm opacity-60 text-center mb-4">
              Your password has been changed successfully.
            </p>
            <button onClick={() => navigate('/')} className="btn btn-primary btn-sm w-full">
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-2xl mb-1">Change Password</h2>
          <p className="text-sm opacity-50 mb-4">Update the password on your account.</p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">Current password</label>
              <input
                type="password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                className={`input input-bordered w-full ${error === 'Current password is incorrect' ? 'input-error' : ''}`}
                autoComplete="current-password"
                autoFocus
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
                <p className={`text-xs mt-1 px-1 ${pwValidationError ? 'text-warning' : 'text-success'}`}>
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

            <p className="text-xs opacity-40 px-1">Min 8 chars · 1 uppercase · 1 number or symbol</p>

            {error && <p className="text-error text-sm">{error}</p>}

            <div className="flex gap-2 mt-2">
              <Link to="/" className="btn btn-ghost flex-1">Cancel</Link>
              <button
                type="submit"
                disabled={loading || !currentPw || !newPw || !confirmNewPw || !!pwValidationError}
                className="btn btn-primary flex-1"
              >
                {loading ? <span className="loading loading-spinner loading-sm" /> : 'Update'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
