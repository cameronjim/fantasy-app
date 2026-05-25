import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Navbar } from './components/Navbar';
import { StatsPage } from './pages/StatsPage';
import { FantasyPage } from './pages/FantasyPage';
import { ImproveTeamPage } from './pages/ImproveTeamPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ProfilePage } from './pages/ProfilePage';
import { PreferencesPage } from './pages/PreferencesPage';
import { getAuthToken, setAuthToken } from './api/client';

export const App = (): JSX.Element => {
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!getAuthToken());

  const handleLogout = (): void => {
    setAuthToken(null);
    setIsLoggedIn(false);
  };

  const handleLoginSuccess = (): void => {
    setIsLoggedIn(true);
  };

  // Google client ID is a public-by-design identifier — safe in the bundle.
  // If unset we fall back to an empty string, which makes GoogleLogin a no-op.
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

  return (
    <GoogleOAuthProvider clientId={googleClientId}>
      <BrowserRouter>
        <div className="min-h-screen bg-base-100 text-base-content">
          <Navbar isLoggedIn={isLoggedIn} onLogout={handleLogout} />
          <main>
            <Routes>
              <Route path="/" element={<StatsPage />} />
              <Route path="/fantasy" element={<FantasyPage isLoggedIn={isLoggedIn} />} />
              <Route path="/improve" element={<ImproveTeamPage isLoggedIn={isLoggedIn} />} />
              <Route path="/login" element={<LoginPage onLogin={handleLoginSuccess} />} />
              <Route path="/register" element={<RegisterPage onRegister={handleLoginSuccess} />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              {/* legacy route — redirect to the Change Password tab inside /profile. */}
              <Route path="/change-password" element={<Navigate to="/profile#password" replace />} />
              <Route path="/preferences" element={<PreferencesPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </GoogleOAuthProvider>
  );
};
