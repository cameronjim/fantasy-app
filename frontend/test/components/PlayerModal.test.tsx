import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerModal } from '../../src/components/PlayerModal';
import type { Player } from '../../src/types';

const samplePlayer: Player = {
  id: 1,
  name: 'Test Player',
  team: 'LAL',
  position: 'PG',
  points_per_game: 27.3,
  rebounds_per_game: 7.2,
  assists_per_game: 5.1,
  steals_per_game: 1.0,
  blocks_per_game: 0.7,
  field_goal_percentage: 48.5,
  three_point_percentage: 36.2,
  free_throw_percentage: 80.1,
  three_pointers_made: 2.6,
  turnovers_per_game: 2.9,
  minutes_per_game: 34.5,
  games_played: 50,
  injury_status: null,
  injury_detail: null,
};

describe('PlayerModal', () => {
  it('renders nothing when no player is selected', () => {
    // arrange + act
    const { container } = render(<PlayerModal player={null} onClose={() => {}} />);

    // assert
    expect(container.firstChild).toBeNull();
  });

  it('renders the player name, team, position, and formatted stats', () => {
    // arrange + act
    render(<PlayerModal player={samplePlayer} onClose={() => {}} />);

    // assert
    expect(screen.getByRole('heading', { name: 'Test Player' })).toBeInTheDocument();
    expect(screen.getByText(/LAL.*PG/)).toBeInTheDocument();
    expect(screen.getByText('27.3')).toBeInTheDocument();
    expect(screen.getByText('48.5%')).toBeInTheDocument();
  });

  it('shows an injury alert when injury_status is set', () => {
    // arrange
    const injured: Player = { ...samplePlayer, injury_status: 'Day_To_Day', injury_detail: 'ankle' };

    // act
    render(<PlayerModal player={injured} onClose={() => {}} />);

    // assert
    expect(screen.getByText(/Day To Day/i)).toBeInTheDocument();
    expect(screen.getByText(/ankle/i)).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', async () => {
    // arrange
    const onClose = vi.fn();
    render(<PlayerModal player={samplePlayer} onClose={onClose} />);
    const user = userEvent.setup();

    // act
    await user.click(screen.getByRole('button', { name: '✕' }));

    // assert
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
