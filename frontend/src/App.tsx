import { useState } from 'react';
import Navbar from './components/Navbar';
import StatsPage from './pages/StatsPage';
import FantasyPage from './pages/FantasyPage';
import ImproveTeamPage from './pages/ImproveTeamPage';

export default function App() {
  const [activeTab, setActiveTab] = useState('stats');

  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      <Navbar activeTab={activeTab} onTabChange={setActiveTab} />
      <main>
        {activeTab === 'stats' && <StatsPage />}
        {activeTab === 'fantasy' && <FantasyPage />}
        {activeTab === 'improve' && <ImproveTeamPage />}
      </main>
    </div>
  );
}
