import { TrendingUp, TrendingDown, Lightbulb, Loader2 } from 'lucide-react';
import type { TeamAnalysis } from '../types';

interface TeamAnalysisCardProps {
  analysis: TeamAnalysis | null;
  loading: boolean;
  onRefresh?: () => void;
}

export const TeamAnalysisCard = ({ analysis, loading, onRefresh }: TeamAnalysisCardProps) => {
  if (loading) {
    return (
      <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] p-8 flex flex-col items-center justify-center">
        <Loader2 size={28} className="text-[#3b82f6] animate-spin mb-3" />
        <p className="text-[#9ca3af] text-sm">Analyzing your team...</p>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] p-6 text-center">
        <p className="text-[#6b7280] text-sm">Select a team to see analysis</p>
      </div>
    );
  }

  const sections = [
    {
      title: 'Strengths',
      items: analysis.strengths,
      icon: TrendingUp,
      colorClass: 'text-[#22c55e]',
      dotClass: 'bg-[#22c55e]',
    },
    {
      title: 'Weaknesses',
      items: analysis.weaknesses,
      icon: TrendingDown,
      colorClass: 'text-[#ef4444]',
      dotClass: 'bg-[#ef4444]',
    },
    {
      title: 'Suggestions',
      items: analysis.suggestions,
      icon: Lightbulb,
      colorClass: 'text-[#3b82f6]',
      dotClass: 'bg-[#3b82f6]',
    },
  ];

  return (
    <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2a2d3a] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Team Analysis</h3>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="text-xs text-[#3b82f6] hover:text-[#60a5fa] transition-colors cursor-pointer"
          >
            Refresh
          </button>
        )}
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <div key={section.title} className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon size={14} className={section.colorClass} />
                <span className={`text-xs font-semibold uppercase tracking-wider ${section.colorClass}`}>
                  {section.title}
                </span>
              </div>
              <div className="space-y-1.5">
                {section.items.map((item, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[#252836]"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${section.dotClass}`} />
                    <span className="text-xs text-[#d1d5db] leading-relaxed">{item}</span>
                  </div>
                ))}
                {section.items.length === 0 && (
                  <p className="text-xs text-[#4b5063] italic px-3">None identified</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
