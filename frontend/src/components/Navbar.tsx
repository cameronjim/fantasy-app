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
    <nav className="bg-[#1a1d29] border-b border-[#2a2d3a] sticky top-0 z-50">
      <div className="max-w-[1400px] mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl leading-none select-none">🏀</span>
            <span className="text-xl font-bold text-white tracking-tight">
              Fantasy <span className="text-[#3b82f6]">NBA</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${
                    isActive
                      ? 'bg-[#3b82f6] text-white shadow-lg shadow-blue-500/20'
                      : 'text-[#9ca3af] hover:text-white hover:bg-[#252836]'
                  }`}
                >
                  <Icon size={16} />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
