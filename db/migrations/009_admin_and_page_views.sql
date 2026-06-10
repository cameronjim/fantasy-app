-- admin flag + page-view analytics backing the /admin developer tools page.

-- server-enforced admin role. there is no signup path to admin — grant it
-- manually, e.g.:  UPDATE users SET is_admin = TRUE WHERE email = 'you@example.com';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- one row per SPA navigation, posted by the frontend tracker. user_id is null
-- for logged-out visitors; ON DELETE SET NULL keeps history if a user is removed.
-- only the pathname is stored (never query strings — reset tokens live there).
CREATE TABLE IF NOT EXISTS page_views (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    path VARCHAR(300) NOT NULL,
    referrer VARCHAR(300),
    user_agent VARCHAR(300),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- the admin dashboard reads recent-first and per-user last-seen.
CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_user ON page_views(user_id, created_at DESC);
