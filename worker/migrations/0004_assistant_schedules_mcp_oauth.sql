-- Wave 12, release 3: instant chat threads, schedules, daily brief, and OAuth for MCP.
-- Additive only: new tables, new columns, new indexes. Nothing is dropped or renamed.

-- A1: instant chat threads and messages. Retention prunes rows older than 30 days by default.
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  tokens_used INTEGER,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, at);

-- A2 and A3: cron schedules in D1. The built-in daily brief is off until a notification channel exists.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  cron TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'America/Chicago',
  brief TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'general',
  kind TEXT NOT NULL DEFAULT 'task',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at);

INSERT OR IGNORE INTO schedules (id, label, cron, tz, brief, task_type, kind, enabled, last_run_at, next_run_at, created_at, updated_at)
VALUES ('sched_daily_brief', 'Daily brief', '30 7 * * *', 'America/Chicago', 'Build the daily brief from weather, calendar, tasks, approvals, keys, research, and health.', 'brief', 'daily_brief', 0, NULL, NULL, '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');

-- M5: OAuth 2.1 with PKCE for MCP clients such as the Claude app and the MCP Inspector.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

ALTER TABLE mcp_tokens ADD COLUMN refresh_token_hash TEXT;
