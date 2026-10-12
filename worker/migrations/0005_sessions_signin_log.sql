-- Daily assistant run, RT5: dashboard sessions, the sign-in log, and rate limits.
-- Additive only: new tables, one new column, new indexes. Nothing is dropped or renamed.

-- A session replaces the long-lived admin token in the browser. The table holds the SHA-256 hash of the session token,
-- never the token. A session ends after an idle time or an absolute time, whichever comes first.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Every sign-in attempt, and every wrong token on a protected route. Shown only behind a sign-in. Never in state/ and
-- never on the public site. Retention prunes rows older than 90 days.
CREATE TABLE IF NOT EXISTS signin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT,
  route TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signin_log_at ON signin_log(at);

-- Sign-in limits. One row for each client (a hash of the IP address) and one row for all clients ('global').
CREATE TABLE IF NOT EXISTS login_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  failures INTEGER NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

-- A fixed-window counter for public routes that write, such as client registration.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- The wrong-token lockout of every protected route now doubles each time a client is locked again.
ALTER TABLE auth_failures ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0;
