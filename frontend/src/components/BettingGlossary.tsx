import { GraduationCap } from 'lucide-react';

const ENTRIES = [
  {
    term: 'Moneyline',
    body: 'The simplest bet: pick which team wins the game, no point spread involved. The odds tell you the payout — a favorite at -130 means you risk $130 to win $100; an underdog at +105 means you risk $100 to win $105. Bigger negative number = heavier favorite.',
  },
  {
    term: 'Spread (point spread)',
    body: 'A handicap that levels the matchup. If the Knicks are -2.5, they must win by 3 or more for a Knicks spread bet to cash. The other side, Spurs +2.5, wins if the Spurs win outright OR lose by 1-2 points. Spread bets usually pay close to even money (around -110).',
  },
  {
    term: 'Total (over/under)',
    body: "A bet on the combined final score of both teams, not who wins. If the total is 216.5, the over cashes when the teams combine for 217+, the under for 216 or fewer. You're betting on game pace and offense, not the winner.",
  },
  {
    term: 'Implied probability',
    body: 'What the price says about the chances. Odds of -110 imply about a 52.4% chance; +150 implies 40%. We show this next to every line. A bet is only "good value" if the TRUE chance is higher than the implied one — that gap is the edge.',
  },
  {
    term: 'Vig (the house cut)',
    body: "Add up the implied probabilities of both sides of a bet and you'll get more than 100% — that extra is the sportsbook's built-in fee, the vig. It's why betting both sides loses money, and why you need a real edge just to break even long-term.",
  },
  {
    term: 'Why parlays are usually bad value',
    body: "A parlay combines multiple bets; ALL legs must win. Payouts look exciting, but the book's vig compounds across every leg, so the price you get is worse than the true combined odds. They're fun lottery tickets — keep stakes small and don't make them your main strategy.",
  },
  {
    term: 'Kelly stake sizing',
    body: "A formula for how much of your bankroll to bet given your edge: bigger edge and better odds → bigger bet; no edge → bet nothing. We use quarter-Kelly (25% of the formula's suggestion) because the AI's win-probability estimates are educated guesses, and overbetting a wrong estimate is how bankrolls die.",
  },
  {
    term: 'Push',
    body: "A tie with the line — e.g. you took -6 and the team won by exactly 6, or the total landed exactly on the number. Your stake is returned; nobody wins. Half-point lines (-6.5) exist specifically so pushes can't happen.",
  },
];

/** plain-english primer for users new to sports betting. static content. */
export const BettingGlossary = () => (
  <div className="card bg-base-200 overflow-hidden">
    <div className="px-4 py-3 border-b border-base-300 flex items-center gap-2">
      <GraduationCap size={16} className="text-primary" />
      <h2 className="text-sm font-semibold">New to betting? Start here</h2>
    </div>
    <div className="p-4 space-y-2">
      {ENTRIES.map((entry) => (
        <div key={entry.term} className="collapse collapse-arrow bg-base-300 rounded-lg">
          <input type="checkbox" aria-label={`Toggle explanation of ${entry.term}`} />
          <div className="collapse-title text-sm font-medium min-h-0 py-3">{entry.term}</div>
          <div className="collapse-content">
            <p className="text-xs opacity-70 leading-relaxed">{entry.body}</p>
          </div>
        </div>
      ))}
    </div>
  </div>
);
