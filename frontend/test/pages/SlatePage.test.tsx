import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SlatePage } from '../../src/pages/SlatePage';
import type { SlateResponse } from '../../src/types';

// mock the api boundary — these tests exercise the page's branches, not http.
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return { ...actual, getSlate: vi.fn() };
});

const { getSlate } = await import('../../src/api/client');
const slateMock = vi.mocked(getSlate);

function payload(overrides: Partial<SlateResponse> = {}): SlateResponse {
  return {
    date: '2026-02-04',
    run: { model_version: 'v1-decomposed', predicted_at: '2026-02-04T11:00:00Z' },
    games: [
      {
        nba_game_id: '0022500555',
        game_status: 'Scheduled',
        home_team_id: '1610612747',
        home_team_abbr: 'LAL',
        away_team_id: '1610612744',
        away_team_abbr: 'GSW',
        players: [
          {
            nba_player_id: '201939',
            name: 'Stephen Curry',
            team_abbr: 'GSW',
            prob_active: 0.99,
            proj_pts: 28.4,
            proj_min_p50: 33.1,
          },
          {
            nba_player_id: '2544',
            name: 'LeBron James',
            team_abbr: 'LAL',
            prob_active: 0.42,
            proj_pts: 18.6,
            proj_min_p50: 30.5,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/slate']}>
      <SlatePage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  slateMock.mockResolvedValue(payload());
});

describe('SlatePage', () => {
  it('renders each game as a card with its projected players', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByRole('heading', { name: /GSW.*@.*LAL/ })).toBeInTheDocument();
    expect(screen.getByText('Stephen Curry')).toBeInTheDocument();
    expect(screen.getByText('LeBron James')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('shows the projected line and availability percentage for each player', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — points, minutes and the availability badge
    expect(screen.getByText('28.4')).toBeInTheDocument();
    expect(screen.getByText(/33\.1 min/)).toBeInTheDocument();
    expect(screen.getByText('99%')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('names the model run behind the projections', async () => {
    // arrange + act
    renderPage();

    // assert
    expect(await screen.findByText(/model v1-decomposed/)).toBeInTheDocument();
  });

  it('renders an em dash when availability was not modelled', async () => {
    // arrange
    slateMock.mockResolvedValue(
      payload({
        games: [
          {
            ...payload().games[0],
            players: [
              {
                nba_player_id: '201939',
                name: 'Stephen Curry',
                team_abbr: 'GSW',
                prob_active: null,
                proj_pts: 28.4,
                proj_min_p50: 33.1,
              },
            ],
          },
        ],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText('Stephen Curry')).toBeInTheDocument();
    expect(screen.getByTitle('Availability not modelled')).toHaveTextContent('—');
  });

  it('explains that no model run has completed yet, while still listing the games', async () => {
    // arrange
    slateMock.mockResolvedValue(
      payload({
        run: null,
        games: [{ ...payload().games[0], players: [] }],
      })
    );

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/No prediction run yet/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /GSW.*@.*LAL/ })).toBeInTheDocument();
    expect(screen.getByText(/No projected players for this game yet/i)).toBeInTheDocument();
  });

  it('shows an empty state for a day with no games', async () => {
    // arrange
    slateMock.mockResolvedValue(payload({ games: [] }));

    // act
    renderPage();

    // assert
    expect(await screen.findByText('No games scheduled')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /the watchlist/i })).toHaveAttribute(
      'href',
      '/watchlist'
    );
  });

  it('refetches for another date when the picker changes', async () => {
    // arrange
    renderPage();
    await screen.findByText('Stephen Curry');
    slateMock.mockResolvedValue(payload({ date: '2026-02-06', games: [] }));

    // act — a date input is set wholesale, not typed character by character
    fireEvent.change(screen.getByLabelText('Game date'), { target: { value: '2026-02-06' } });

    // assert
    expect(await screen.findByText('No games scheduled')).toBeInTheDocument();
    expect(slateMock).toHaveBeenLastCalledWith('2026-02-06');
  });

  it('shows an error state with a retry button when the request fails', async () => {
    // arrange
    slateMock.mockRejectedValue(new Error('slate down'));

    // act
    renderPage();

    // assert
    expect(await screen.findByText(/Failed to load the slate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeInTheDocument();
  });

  it('orders the players as the server ranked them', async () => {
    // arrange + act
    renderPage();
    await screen.findByText('Stephen Curry');

    // assert — the server ranks by projected points; the page must not resort
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('Stephen Curry')).toBeInTheDocument();
    expect(within(rows[1]).getByText('LeBron James')).toBeInTheDocument();
  });
});
