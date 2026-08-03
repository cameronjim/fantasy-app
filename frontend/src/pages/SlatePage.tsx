import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { getSlate } from '../api/client';
import { useCachedResource } from '../hooks/useCachedResource';
import { formatTimestamp } from '../utils/analytics';
import { formatStat, toStatNumber } from '../utils/stats';
import type { SlateGame, SlatePlayer, SlateResponse } from '../types';

/**
 * NBA game days run on the Eastern calendar, so "today" here is ET rather
 * than the browser's timezone — otherwise a west-coast user opens the page
 * before tip-off and sees yesterday's slate.
 */
function todayInEastern(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** "Wed, Feb 4" — the heading format for a game day. */
function formatSlateDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * daisyUI semantic color for an availability percentage. Semantic classes keep
 * this readable on every theme instead of hardcoding a palette.
 */
function availabilityClass(probability: number): string {
  if (probability >= 0.85) return 'badge-success';
  if (probability >= 0.6) return 'badge-warning';
  return 'badge-error';
}

const AvailabilityBadge = ({ value }: { value: SlatePlayer['prob_active'] }): JSX.Element => {
  const probability = toStatNumber(value);
  if (probability === null) {
    return (
      <span className="badge badge-ghost badge-sm tabular-nums" title="Availability not modelled">
        —
      </span>
    );
  }
  return (
    <span
      className={`badge badge-sm tabular-nums ${availabilityClass(probability)}`}
      title="Modelled chance this player appears"
    >
      {Math.round(probability * 100)}%
    </span>
  );
};

const PlayerRow = ({ player }: { player: SlatePlayer }): JSX.Element => (
  <li className="grid grid-cols-[1fr_auto_auto] items-center gap-2 sm:gap-3 py-1.5">
    <span className="min-w-0">
      <span className="text-sm font-medium truncate block">{player.name}</span>
      {player.team_abbr && (
        <span className="text-[11px] opacity-50 uppercase tracking-wider">{player.team_abbr}</span>
      )}
    </span>

    <span className="text-xs tabular-nums opacity-70 text-right whitespace-nowrap">
      <span className="font-semibold opacity-100">{formatStat(player.proj_pts)}</span> pts
      <span className="opacity-40"> · </span>
      {formatStat(player.proj_min_p50)} min
    </span>

    <AvailabilityBadge value={player.prob_active} />
  </li>
);

const GameCard = ({ game }: { game: SlateGame }): JSX.Element => (
  <section className="card bg-base-200 border border-base-300">
    <div className="card-body p-4 sm:p-5 gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-bold text-base tracking-tight">
          {game.away_team_abbr ?? 'TBD'} <span className="opacity-40 font-normal">@</span>{' '}
          {game.home_team_abbr ?? 'TBD'}
        </h2>
        {game.game_status && (
          <span className="badge badge-ghost badge-sm shrink-0">{game.game_status}</span>
        )}
      </div>

      {game.players.length === 0 ? (
        <p className="text-xs opacity-50 py-2">No projected players for this game yet.</p>
      ) : (
        <ul className="divide-y divide-base-300">
          {game.players.map((player) => (
            <PlayerRow key={player.nba_player_id} player={player} />
          ))}
        </ul>
      )}
    </div>
  </section>
);

const NO_RUN_NOTICE = 'No prediction run yet — check back after the next model run.';

/**
 * The day's games with each game's top projected players. Every part of the
 * payload is optional in practice: the schedule can be empty (no games), the
 * run can be absent (model hasn't run), and a scheduled game can have no
 * projected players. Each of those renders its own notice rather than an error.
 */
export const SlatePage = (): JSX.Element => {
  const [date, setDate] = useState(todayInEastern);

  const { data, loading, error, reload } = useCachedResource<SlateResponse>(
    `slate:${date}`,
    () => getSlate(date),
    { errorMessage: 'Failed to load the slate' }
  );

  const predictedAt = formatTimestamp(data?.run?.predicted_at ?? null);

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="font-bold text-xl sm:text-2xl leading-tight flex items-center gap-2">
            <CalendarDays size={20} className="opacity-60" />
            Today&apos;s Projections
          </h1>
          <p className="text-sm opacity-60 mt-0.5">
            {formatSlateDate(data?.date ?? date)}
            {data?.run && (
              <>
                <span className="opacity-40"> · </span>
                model {data.run.model_version}
                {predictedAt && ` · run ${predictedAt}`}
              </>
            )}
          </p>
        </div>

        <label className="form-control">
          <span className="sr-only">Game date</span>
          <input
            type="date"
            className="input input-bordered input-sm"
            value={date}
            aria-label="Game date"
            onChange={(e) => setDate(e.target.value || todayInEastern())}
          />
        </label>
      </header>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      ) : !data ? (
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body flex flex-col items-center py-12 gap-4">
            <p className="text-error text-sm">{error || 'Failed to load the slate'}</p>
            <button onClick={() => void reload()} className="btn btn-primary btn-sm">
              Try Again
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {!data.run && (
            <div className="alert alert-info py-2.5 px-3">
              <span className="text-sm">{NO_RUN_NOTICE}</span>
            </div>
          )}

          {data.games.length === 0 ? (
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body items-center text-center py-12 gap-1">
                <p className="text-sm font-semibold">No games scheduled</p>
                <p className="text-xs opacity-60 max-w-md">
                  Nothing is on the NBA schedule for {formatSlateDate(data.date)}. Pick another
                  date, or see{' '}
                  <Link to="/watchlist" className="link link-primary">
                    the watchlist
                  </Link>{' '}
                  for players worth tracking regardless of tonight&apos;s games.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.games.map((game) => (
                <GameCard key={game.nba_game_id} game={game} />
              ))}
            </div>
          )}
        </div>
      )}

      <footer className="text-[11px] opacity-40 mt-6 pt-3 border-t border-base-300">
        Projected points are unconditional — the chance of playing is already priced in, so a
        game-time decision projects lower than the same player would if he were certain to suit up.
      </footer>
    </div>
  );
};
