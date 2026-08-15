import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { forgotPassword } from '../api/client';

export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await forgotPassword(email);
      setSubmitted(true);
    } catch {
      // the endpoint never leaks, so only unexpected client errors are caught.
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4 py-8">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          {submitted ? (
            <>
              <div className="flex justify-center mb-3">
                <div className="bg-success/15 text-success rounded-full p-3">
                  <Mail size={28} />
                </div>
              </div>
              <h2 className="card-title justify-center text-xl mb-2">Check your inbox</h2>
              <p className="text-sm opacity-60 text-center mb-4">
                If an account exists with <strong className="opacity-90">{email}</strong>, we've sent a link to reset your password. The link expires in 1 hour.
              </p>
              <Link to="/login" className="btn btn-ghost btn-sm w-full">
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h2 className="card-title text-2xl mb-1">Forgot Password</h2>
              <p className="text-sm opacity-50 mb-4">
                Enter your email and we'll send you a reset link.
              </p>

              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label className="text-xs font-medium opacity-60 mb-1 block">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input input-bordered w-full"
                    autoFocus
                    autoComplete="email"
                    required
                  />
                </div>

                {error && <p className="text-error text-sm">{error}</p>}

                <button
                  type="submit"
                  disabled={loading || !email}
                  className="btn btn-primary w-full mt-2"
                >
                  {loading ? <span className="loading loading-spinner loading-sm" /> : 'Send reset link'}
                </button>
              </form>

              <div className="divider text-xs opacity-50 my-4">or</div>

              <p className="text-center text-sm opacity-70">
                Remember your password?{' '}
                <Link to="/login" className="text-primary hover:underline font-medium">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
