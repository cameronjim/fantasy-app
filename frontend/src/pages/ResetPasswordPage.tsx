import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { resetPassword } from '../api/client';

function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'At least 8 characters required';
  if (!/[A-Z]/.test(pwd)) return 'Must include at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pwd)) return 'Must include at least one number or symbol';
  return null;
}

export const ResetPasswordPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const pwValidationError = newPassword ? validatePassword(newPassword) : null;

  if (!token) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
        <div className="card bg-base-200 w-full max-w-sm shadow-xl">
          <div className="card-body">
            <div className="flex justify-center mb-3">
              <div className="bg-warning/15 text-warning rounded-full p-3">
                <AlertTriangle size={28} />
              </div>
            </div>
            <h2 className="card-title justify-center text-xl mb-2">Invalid reset link</h2>
            <p className="text-sm opacity-60 text-center mb-4">
              This link is missing its token. Request a new reset link to continue.
            </p>
            <Link to="/forgot-password" className="btn btn-primary btn-sm w-full">
              Request new link
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');

    const pwErr = validatePassword(newPassword);
    if (pwErr) {
      setError(pwErr);
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await resetPassword(token, newPassword);
      setSuccess(true);
      // Auto-redirect to login after a beat.
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Failed to reset password');
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
              You'll be redirected to sign in.
            </p>
            <Link to="/login" className="btn btn-primary btn-sm w-full">
              Sign in now
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-2xl mb-1">Reset Password</h2>
          <p className="text-sm opacity-50 mb-4">Choose a new password for your account.</p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input input-bordered w-full"
                autoFocus
                autoComplete="new-password"
              />
              {newPassword && (
                <p className={`text-xs mt-1 px-1 ${pwValidationError ? 'text-warning' : 'text-success'}`}>
                  {pwValidationError ?? '✓ Password looks good'}
                </p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">Confirm password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="input input-bordered w-full"
                autoComplete="new-password"
              />
            </div>

            <p className="text-xs opacity-40 px-1">Min 8 chars · 1 uppercase · 1 number or symbol</p>

            {error && <p className="text-error text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading || !newPassword || !confirm || !!pwValidationError}
              className="btn btn-primary w-full mt-2"
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
