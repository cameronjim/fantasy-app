import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProfilePage } from '../../src/pages/ProfilePage';
import { AdminPage } from '../../src/pages/AdminPage';

// the real token store must survive the mock, hence importOriginal.
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

describe('auth-guarded pages survive the token disappearing mid-mount', () => {
  it('ProfilePage redirects to /login instead of crashing', async () => {
    setAuthToken('test-token');
    const view = renderAt('/profile', <ProfilePage />);

    setAuthToken(null);
    view.rerender(
      <MemoryRouter initialEntries={['/profile']}>
        <Routes>
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('login page')).toBeInTheDocument();
  });

  it('AdminPage redirects to /login instead of crashing', async () => {
    setAuthToken('test-token');
    const view = renderAt('/admin', <AdminPage />);

    setAuthToken(null);
    view.rerender(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('login page')).toBeInTheDocument();
  });
});
