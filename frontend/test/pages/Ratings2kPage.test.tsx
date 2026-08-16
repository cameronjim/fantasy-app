import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Ratings2kPage } from '../../src/pages/Ratings2kPage';
import type { Rating2kDetail, Rating2kSummary, Rating2kTeamType } from '../../src/types';

// mock the api boundary — these tests exercise the page's branches, not http.
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    getRatings2kPlayers: vi.fn(),
    getRatings2kPlayer: vi.fn(),
  };
});

const { getRatings2kPlayers, getRatings2kPlayer } = await import('../../src/api/client');
const playersMock = vi.mocked(getRatings2kPlayers);
const detailMock = vi.mocked(getRatings2kPlayer);

function summary(overrides: Partial<Rating2kSummary> = {}): Rating2kSummary {
  return {
    slug: 'nikola-jokic',
    name: 'Nikola Jokic',
    team: 'Denver Nuggets',
    team_type: 'curr' as Rating2kTeamType,
    overall: 98,
    positions: ['C'],
    game_version: 'NBA 2K25',
    player_image: null,
    ...overrides,
  };
}

const DETAIL: Rating2kDetail = {
  player: {
    ...summary(),
    archetype: 'Two-Way Playmaking Big',
    build: 'Point Center',
    height: '6\'11"',
    weight: '284 lbs',
    wingspan: '7\'3"',
  },
  attributes: [
    { attribute_name: 'threePointShot', value: 82 },
    { attribute_name: 'passVision', value: 95 },
  ],
  badges: [],
  rating_history: [{ game_version: 'NBA 2K25', overall: 98, delta: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  playersMock.mockResolvedValue({
    total: 2,
    players: [
      summary(),
      summary({ slug: 'luka-doncic', name: 'Luka Doncic', team: 'Dallas Mavericks', overall: 96 }),
    ],
  });
  detailMock.mockResolvedValue(DETAIL);
});

describe('Ratings2kPage', () => {
  it('renders the current roster rows by default', async () => {
    // arrange + act
    render(<Ratings2kPage />);

    // assert
    expect(await screen.findByText('Nikola Jokic')).toBeInTheDocument();
    expect(screen.getByText('Luka Doncic')).toBeInTheDocument();
    expect(playersMock).toHaveBeenCalledWith(expect.objectContaining({ teamType: 'curr' }));
  });

  it('refetches with the new team type when the toggle is used', async () => {
    // arrange
    render(<Ratings2kPage />);
    await screen.findByText('Nikola Jokic');
    playersMock.mockResolvedValue({
      total: 1,
      players: [
        summary({
          slug: 'michael-jordan-96-bulls',
          name: 'Michael Jordan',
          team: '1995-96 Chicago Bulls',
          team_type: 'class',
          overall: 99,
        }),
      ],
    });
    const user = userEvent.setup();

    // act
    await user.click(screen.getByRole('button', { name: 'Classic' }));

    // assert
    expect(await screen.findByText('Michael Jordan')).toBeInTheDocument();
    expect(playersMock).toHaveBeenCalledWith(expect.objectContaining({ teamType: 'class' }));
    expect(screen.queryByText('Nikola Jokic')).not.toBeInTheDocument();
  });

  it('filters the rendered rows by the search box', async () => {
    // arrange
    render(<Ratings2kPage />);
    await screen.findByText('Nikola Jokic');
    const user = userEvent.setup();

    // act
    await user.type(screen.getByLabelText('Search players'), 'luka');

    // assert
    expect(screen.getByText('Luka Doncic')).toBeInTheDocument();
    expect(screen.queryByText('Nikola Jokic')).not.toBeInTheDocument();
  });

  it('keeps rendering rows after sorting by every sortable column', async () => {
    // arrange
    render(<Ratings2kPage />);
    await screen.findByText('Nikola Jokic');
    const user = userEvent.setup();

    // act — toggle each column twice to flip both directions
    await user.click(screen.getByTitle('Overall Rating'));
    await user.click(screen.getByTitle('Overall Rating'));
    await user.click(screen.getByTitle('Player Name'));
    await user.click(screen.getByTitle('Player Name'));
    await user.click(screen.getByTitle('Team'));

    // assert
    expect(screen.getByText('Nikola Jokic')).toBeInTheDocument();
    expect(screen.getByText('Luka Doncic')).toBeInTheDocument();
  });

  it('opens the attribute modal when a row is clicked', async () => {
    // arrange
    render(<Ratings2kPage />);
    const user = userEvent.setup();

    // act
    await user.click(await screen.findByText('Nikola Jokic'));

    // assert
    expect(await screen.findByText('Three Point Shot')).toBeInTheDocument();
    expect(screen.getByText('Pass Vision')).toBeInTheDocument();
    expect(detailMock).toHaveBeenCalledWith('nikola-jokic');
  });

  it('shows the empty state when the 2K import has not run yet', async () => {
    // arrange
    playersMock.mockResolvedValue({ total: 0, players: [] });

    // act
    render(<Ratings2kPage />);

    // assert
    expect(await screen.findByText(/No 2K ratings available yet/i)).toBeInTheDocument();
    expect(screen.queryByText('No players found')).not.toBeInTheDocument();
  });

  it('shows an error state with a retry button when the list fails', async () => {
    // arrange
    playersMock.mockRejectedValue(new Error('ratings down'));

    // act
    render(<Ratings2kPage />);

    // assert
    expect(await screen.findByText(/Failed to load 2K ratings/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });

  it('renders the attribution footnote and no raw nulls', async () => {
    // arrange
    playersMock.mockResolvedValue({
      total: 1,
      players: [summary({ team: null, positions: null, overall: null, game_version: null })],
    });

    // act
    const { container } = render(<Ratings2kPage />);
    await screen.findByText('Nikola Jokic');

    // assert
    expect(screen.getByText(/nba2kapi\.com/)).toBeInTheDocument();
    await waitFor(() => {
      expect(container.textContent).not.toMatch(/NaN|null|undefined/);
    });
  });
});
