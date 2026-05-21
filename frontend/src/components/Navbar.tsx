import { BarChart3, Users, TrendingUp } from 'lucide-react';

interface NavbarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const tabs = [
  { id: 'stats', label: 'Stats', icon: BarChart3 },
  { id: 'fantasy', label: 'My Team', icon: Users },
  { id: 'improve', label: 'Improve Team', icon: TrendingUp },
];

export default function Navbar({ activeTab, onTabChange }: NavbarProps) {
  return (
    <div className="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4">
      <div className="flex-1">
        <span className="flex items-center gap-2 text-xl font-bold">
          <span className="text-2xl leading-none select-none">🏀</span>
          Fantasy <span className="text-primary">NBA</span>
        </span>
      </div>
      <div className="flex-none gap-1">
        {tabs.map((tab) => {
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
      </div>
    </div>
  );
}
