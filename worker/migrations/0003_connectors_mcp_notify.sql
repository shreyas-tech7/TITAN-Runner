-- Wave 12, release 2: connectors, approvals, inbound hooks, OAuth state, MCP, notify rules. Every change adds a table or an index.
-- Nothing here drops or renames a column.

-- C3: one row for each connection. Only fields that are not secret are stored here. A secret sits in vault_records
-- under the id conn:<connectionId>:<field>.
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_names TEXT NOT NULL DEFAULT '[]',
  meta_json TEXT NOT NULL DEFAULT '{}',
  last_test_at TEXT,
  last_test_ok INTEGER,
  last_test_ms INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_label ON connections(connector_id, label);

-- C3: a person may change the default of one action. The mode is ask, auto, or deny.
CREATE TABLE IF NOT EXISTS connector_policies (
  connection_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, action_id)
);

-- C3: the audit log of calls. It holds metadata only, never a payload.
CREATE TABLE IF NOT EXISTS connector_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  caller TEXT NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_calls_at ON connector_calls(at);

CREATE INDEX IF NOT EXISTS idx_connector_calls_conn ON connector_calls(connection_id, at);

-- C3: a counter for each key and each minute. Hooks and actions use it.
CREATE TABLE IF NOT EXISTS connector_rate (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

-- C3 and A4: calls that wait for a person. A write call from a sub-agent or from MCP waits here.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  risk TEXT NOT NULL,
  data_class TEXT NOT NULL,
  summary TEXT NOT NULL,
  input_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  result_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

-- C6: one row for each inbound hook. The hook id is public. The secret sits in the vault, and a hash is kept here.
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  target TEXT NOT NULL,
  task_brief TEXT,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_event_at TEXT,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id TEXT NOT NULL,
  at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  title TEXT
);

CREATE INDEX IF NOT EXISTS idx_hook_events_hook ON hook_events(hook_id, at);

-- C6: a signature that was seen once. It stops a replay inside the 300 second window.
CREATE TABLE IF NOT EXISTS hook_nonces (
  hook_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (hook_id, nonce)
);

-- C8: the state of an OAuth flow that has begun. The PKCE verifier sits in the vault under oauth:<state>.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- M2: tokens that open /mcp. Only a hash is stored. The kind is static for a pasted token.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'static',
  client_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

-- M3: the tools of a remote MCP server, kept after the last refresh. A person sets the risk of each tool.
CREATE TABLE IF NOT EXISTS mcp_remote_tools (
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  risk TEXT NOT NULL DEFAULT 'write',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, name)
);

-- C7: rules of the notification router. An event pattern holds a type or a prefix and a star, such as task.*.
CREATE TABLE IF NOT EXISTS notify_rules (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  event_pattern TEXT NOT NULL,
  min_severity TEXT NOT NULL DEFAULT 'info',
  connection_ids TEXT NOT NULL,
  quiet_start TEXT,
  quiet_end TEXT,
  tz TEXT NOT NULL DEFAULT 'America/Chicago',
  dedupe_minutes INTEGER NOT NULL DEFAULT 30,
  allow_personal INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_notify_deliveries_at ON notify_deliveries(at);
