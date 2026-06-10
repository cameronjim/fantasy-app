import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ShieldAlert, Users, Eye, Activity } from 'lucide-react';
import {
  getAuthToken, getCurrentUser, getAdminStats, getAdminUsers, getAdminViews,
  type AdminStats, type AdminUser, type AdminPageView,
} from '../api/client';

type AdminState =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'error' }
  | { status: 'ready'; stats: AdminStats; users: AdminUser[]; views: AdminPageView[] };

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export const AdminPage = (): JSX.Element => {
  if (!getAuthToken()) {
    return <Navigate to="/login" replace state={{ from: '/admin' }} />;
  }

  const [state, setState] = useState<AdminState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // check the flag before hitting the admin endpoints so non-admins get a
    // clean message instead of three 403s. the server re-checks regardless.
    getCurrentUser()
      .then((user) => {
        if (!user.is_admin) {
          if (!cancelled) setState({ status: 'forbidden' });
          return;
        }
        return Promise.all([getAdminStats(), getAdminUsers(), getAdminViews()]).then(
          ([stats, users, views]) => {
            if (!cancelled) setState({ status: 'ready', stats, users, views });
          }
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex justify-center py-24">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (state.status === 'forbidden') {
    return (
      <div className="max-w-md mx-auto py-24 px-4 text-center">
        <ShieldAlert size={40} className="mx-auto mb-4 text-warning" />
        <h1 className="text-xl font-bold mb-2">Admin access required</h1>
        <p className="opacity-70">Your account doesn't have access to the developer tools.</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="max-w-md mx-auto py-24 px-4">
        <div className="alert alert-error">Failed to load developer tools. Try refreshing.</div>
      </div>
    );
  }

  const { stats, users, views } = state;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Activity size={24} className="text-primary" />
        Developer Tools
      </h1>

      <div className="stats stats-vertical sm:stats-horizontal shadow w-full">
        <div className="stat">
          <div className="stat-title">Total users</div>
          <div className="stat-value text-primary">{stats.totals.total_users}</div>
          <div className="stat-desc">+{stats.totals.new_users_7d} in the last 7 days</div>
        </div>
        <div className="stat">
          <div className="stat-title">Views (24h)</div>
          <div className="stat-value">{stats.totals.views_24h}</div>
          <div className="stat-desc">{stats.totals.views_7d} in the last 7 days</div>
        </div>
        <div className="stat">
          <div className="stat-title">Active users (24h)</div>
          <div className="stat-value">{stats.totals.active_users_24h}</div>
          <div className="stat-desc">signed-in visitors</div>
        </div>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Users size={18} />
          Users ({users.length})
        </h2>
        {users.length === 0 ? (
          <p className="opacity-70">No users yet.</p>
        ) : (
          <div className="overflow-x-auto border border-base-300 rounded-box">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Sign-in</th>
                  <th>Roster</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="font-medium">
                      {user.username}
                      {user.is_admin && <span className="badge badge-primary badge-sm ml-2">admin</span>}
                    </td>
                    <td>{user.email ?? '—'}</td>
                    <td>
                      <div className="flex gap-1">
                        {user.has_password && <span className="badge badge-ghost badge-sm">password</span>}
                        {user.has_google && <span className="badge badge-ghost badge-sm">google</span>}
                      </div>
                    </td>
                    <td>{user.roster_count}</td>
                    <td className="whitespace-nowrap">{formatDate(user.created_at)}</td>
                    <td className="whitespace-nowrap">{formatDate(user.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid lg:grid-cols-2 gap-8">
        <section>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Eye size={18} />
            Top pages (7 days)
          </h2>
          {stats.top_paths.length === 0 ? (
            <p className="opacity-70">No page views recorded yet.</p>
          ) : (
            <div className="overflow-x-auto border border-base-300 rounded-box">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Path</th>
                    <th className="text-right">Views</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.top_paths.map((row) => (
                    <tr key={row.path}>
                      <td className="font-mono">{row.path}</td>
                      <td className="text-right">{row.views}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Activity size={18} />
            Recent activity
          </h2>
          {views.length === 0 ? (
            <p className="opacity-70">No activity yet.</p>
          ) : (
            <div className="overflow-x-auto border border-base-300 rounded-box max-h-96 overflow-y-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Path</th>
                  </tr>
                </thead>
                <tbody>
                  {views.map((view) => (
                    <tr key={view.id}>
                      <td className="whitespace-nowrap">{formatDate(view.created_at)}</td>
                      <td>{view.username ?? <span className="opacity-50">anonymous</span>}</td>
                      <td className="font-mono">{view.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
