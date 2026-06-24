import { useState } from 'react';
import Navbar from './components/Navbar';
import { StatsPage } from './pages/StatsPage';
import { FantasyPage } from './pages/FantasyPage';
import { ImproveTeamPage } from './pages/ImproveTeamPage';
import { getAuthToken, setAuthToken } from './api/client';

export const App = () => {
  const [activeTab, setActiveTab] = useState('stats');
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!getAuthToken());

  const handleLogout = (): void => {
    setAuthToken(null);
    setIsLoggedIn(false);
    setActiveTab('stats');
  };

  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      <Navbar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isLoggedIn={isLoggedIn}
        onLogout={handleLogout}
        onLoginSuccess={() => { setIsLoggedIn(true); setActiveTab('stats'); }}
      />
      <main>
        {activeTab === 'stats' && <StatsPage />}
        {activeTab === 'fantasy' && <FantasyPage isLoggedIn={isLoggedIn} />}
        {activeTab === 'improve' && <ImproveTeamPage isLoggedIn={isLoggedIn} />}
      </main>
    </div>
  );
};
