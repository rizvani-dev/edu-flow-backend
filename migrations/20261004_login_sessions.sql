CREATE TABLE IF NOT EXISTS login_sessions (
  id uuid PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label varchar(120) NOT NULL DEFAULT 'Web browser',
  user_agent varchar(500),
  ip_address inet,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_sessions_user_last_seen
  ON login_sessions (user_id, last_seen_at DESC);
