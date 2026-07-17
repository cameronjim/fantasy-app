import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Link } from 'react-router-dom';
import { PageViewTracker } from '../../src/components/PageViewTracker';
import { trackPageView } from '../../src/api/client';

vi.mock('../../src/api/client', () => ({
  trackPageView: vi.fn(),
}));

const trackMock = vi.mocked(trackPageView);

beforeEach(() => {
  trackMock.mockReset();
});

describe('PageViewTracker', () => {
  it('tracks the initial pathname on mount', () => {
    // arrange + act
    render(
      <MemoryRouter initialEntries={['/betting']}>
        <PageViewTracker />
      </MemoryRouter>
    );

    // assert
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('/betting', undefined);
  });

  it('tracks each in-app navigation', async () => {
    // arrange
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <PageViewTracker />
        <Link to="/fantasy">go</Link>
      </MemoryRouter>
    );

    // act
    await user.click(screen.getByText('go'));

    // assert
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenLastCalledWith('/fantasy', undefined);
  });

  it('never sends the query string', () => {
    // arrange + act — reset-password tokens travel in the query string and
    // must not reach analytics.
    render(
      <MemoryRouter initialEntries={['/reset-password?token=secret']}>
        <PageViewTracker />
      </MemoryRouter>
    );

    // assert
    expect(trackMock).toHaveBeenCalledWith('/reset-password', undefined);
  });
});
