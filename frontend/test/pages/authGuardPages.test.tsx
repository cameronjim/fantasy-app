import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProfilePage } from '../../src/pages/ProfilePage';
import { AdminPage } from '../../src/pages/AdminPage';

// keep the real token store (set/getAuthToken) but stub every network call
// these pages make on mount.
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    getCurrentUser: vi.fn().mockResolvedValue({
      id: 1, username: 'cj', email: 'cj@example.com', name: null, phone: null,
      has_password: false, is_admin: false,
    }),
    getAdminStats: vi.fn(),
    getAdminUsers: vi.fn(),
    getAdminViews: vi.fn(),
  };
});

const { setAuthToken } = await import('../../src/api/client');

beforeEach(() => {
  setAuthToken(null);
});

function renderAt(path: string, element: JSX.Element): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// regression for react error #300: these pages used to early-return the
// login redirect ABOVE their hooks, so a token disappearing while the page
// was mounted (signing out from it) rendered fewer hooks and crashed.
describe('auth-guarded pages survive the token disappearing mid-mount', () => {
  it('ProfilePage redirects to /login instead of crashing', async () => {
    // arrange — mounted while signed in, all hooks registered
    setAuthToken('test-token');
    const view = renderAt('/profile', <ProfilePage />);

    // act — token vanishes (sign-out) and the page re-renders
    setAuthToken(null);
    view.rerender(
      <MemoryRouter initialEntries={['/profile']}>
        <Routes>
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    );

    // assert — clean redirect, no thrown render error
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });

  it('AdminPage redirects to /login instead of crashing', async () => {
    // arrange
    setAuthToken('test-token');
    const view = renderAt('/admin', <AdminPage />);

    // act
    setAuthToken(null);
    view.rerender(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    );

    // assert
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });
});
