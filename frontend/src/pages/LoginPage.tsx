import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { GoogleLogin, useGoogleLogin } from '@react-oauth/google';
import { login, googleSignIn, googleSignInWithToken } from '../api/client';

interface LoginPageProps {
  onLogin: () => void;
}

interface LocationState {
  from?: string;
}

export const LoginPage = ({ onLogin }: LoginPageProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocationState | null;
  const redirectTo = state?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogleSuccess = async (credential: string | undefined): Promise<void> => {
    if (!credential) return;
    setError('');
    setLoading(true);
    try {
      await googleSignIn(credential);
      onLogin();
      navigate(redirectTo, { replace: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  // forces the account picker so users can switch google accounts on a shared device.
  const switchGoogleAccount = useGoogleLogin({
    flow: 'implicit',
    prompt: 'select_account',
    scope: 'openid email profile',
    onSuccess: async (tokenResponse) => {
      setError('');
      setLoading(true);
      try {
        await googleSignInWithToken(tokenResponse.access_token);
        onLogin();
        navigate(redirectTo, { replace: true });
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setError(msg ?? 'Google sign-in failed');
      } finally {
        setLoading(false);
      }
    },
    onError: () => setError('Google sign-in failed'),
  });

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      onLogin();
      navigate(redirectTo, { replace: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Failed to sign in');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-2xl mb-1">Sign In</h2>
          <p className="text-sm opacity-50 mb-4">Welcome back to Fantasy NBA</p>

          <div className="flex flex-col items-center gap-2 mb-4">
            <GoogleLogin
              onSuccess={(resp) => handleGoogleSuccess(resp.credential)}
              onError={() => setError('Google sign-in failed')}
              theme="outline"
              size="large"
              text="continue_with"
              width="290"
            />
            <button
              type="button"
              onClick={() => switchGoogleAccount()}
              className="text-xs text-primary hover:underline cursor-pointer"
            >
              Use a different Google account
            </button>
          </div>

          <div className="divider text-xs opacity-50 my-2">or</div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium opacity-60 mb-1 block">Username or email</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input input-bordered w-full"
                autoFocus
                autoComplete="username"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label className="text-xs font-medium opacity-60">Password</label>
                <Link to="/forgot-password" className="text-xs text-primary hover:underline">
                  Forgot?
                </Link>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input input-bordered w-full"
                autoComplete="current-password"
              />
            </div>

            {error && <p className="text-error text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="btn btn-primary w-full mt-2"
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : 'Sign In'}
            </button>
          </form>

          <div className="divider text-xs opacity-50 my-4">or</div>

          <p className="text-center text-sm opacity-70">
            New here?{' '}
            <Link to="/register" className="text-primary hover:underline font-medium">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};
