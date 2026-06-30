import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { register, googleSignIn } from '../api/client';

interface RegisterPageProps {
  onRegister: () => void;
}

function validatePassword(pwd: string): string | null {
  if (pwd.length < 8) return 'At least 8 characters required';
  if (!/[A-Z]/.test(pwd)) return 'Must include at least one uppercase letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pwd)) return 'Must include at least one number or symbol';
  return null;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export const RegisterPage = ({ onRegister }: RegisterPageProps) => {
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const pwValidationError = password ? validatePassword(password) : null;
  const emailLooksValid = email && isValidEmail(email);

  const handleGoogleSuccess = async (credential: string | undefined): Promise<void> => {
    if (!credential) return;
    setError('');
    setLoading(true);
    try {
      await googleSignIn(credential);
      onRegister();
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');

    if (!isValidEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      setError(pwErr);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await register(username, email, password);
      onRegister();
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-2xl mb-1">Create Account</h2>
          <p className="text-sm opacity-50 mb-4">Join Fantasy NBA</p>

          <div className="flex justify-center mb-4">
            <GoogleLogin
              onSuccess={(resp) => handleGoogleSuccess(resp.credential)}
              onError={() => setError('Google sign-in failed')}
              theme="outline"
              size="large"
              text="signup_with"
              width="290"
            />
          </div>

          <div className="divider text-xs opacity-50 my-2">or</div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input input-bordered w-full"
                autoFocus
                autoComplete="username"
                minLength={3}
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
              {email && !emailLooksValid && (
                <p className="text-xs mt-1 px-1 text-warning">Please enter a valid email address</p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input input-bordered w-full"
                autoComplete="new-password"
              />
              {password && (
                <p className={`text-xs mt-1 px-1 ${pwValidationError ? 'text-warning' : 'text-success'}`}>
                  {pwValidationError ?? '✓ Password looks good'}
                </p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">Confirm password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input input-bordered w-full"
                autoComplete="new-password"
              />
            </div>

            <p className="text-xs opacity-40 px-1">Min 8 chars · 1 uppercase · 1 number or symbol</p>

            {error && <p className="text-error text-sm">{error}</p>}

            <button
              type="submit"
              disabled={
                loading ||
                !username ||
                !email ||
                !password ||
                !confirmPassword ||
                !emailLooksValid ||
                !!pwValidationError
              }
              className="btn btn-primary w-full mt-2"
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : 'Create Account'}
            </button>
          </form>

          <div className="divider text-xs opacity-50 my-4">or</div>

          <p className="text-center text-sm opacity-70">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline font-medium">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};
