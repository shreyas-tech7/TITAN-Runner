-- 0002 Wave 12 release 1. Additive only: new tables, new columns, new indexes. Nothing is dropped or renamed.

-- K2, K3: what the dashboard saved and checked for each provider. The key itself is never stored.
CREATE TABLE IF NOT EXISTS provider_keys (
  provider TEXT PRIMARY KEY,
  fingerprint TEXT,
  last4 TEXT,
  saved_via TEXT NOT NULL DEFAULT 'dashboard',
  saved_at TEXT,
  secrets_json TEXT,
  also_for_chat INTEGER NOT NULL DEFAULT 0,
  check_result TEXT,
  check_status INTEGER,
  check_latency_ms INTEGER,
  check_at TEXT,
  check_detail TEXT,
  proof_result TEXT,
  proof_model TEXT,
  proof_latency_ms INTEGER,
  proof_at TEXT,
  proof_detail TEXT,
  proof_request_id TEXT,
  updated_at TEXT
);

-- K4: the audit log for keys. It holds fingerprints and results, never a key.
CREATE TABLE IF NOT EXISTS key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  provider TEXT,
  fingerprint TEXT,
  old_fingerprint TEXT,
  result TEXT,
  actor TEXT NOT NULL DEFAULT 'admin',
  request_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_key_events_at ON key_events(at);

-- K8: tokens that the Worker manages for itself. Only a hash is stored. Status is pending, active, or retired.
CREATE TABLE IF NOT EXISTS worker_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  activated_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_tokens_kind ON worker_tokens(kind, status);

-- K8: the round trip test of the callback path.
CREATE TABLE IF NOT EXISTS callback_pings (
  id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  received_at TEXT,
  auth_kind TEXT
);

-- S2: wrong token attempts. The key is a hash of the client address and the route group. No raw address.
CREATE TABLE IF NOT EXISTS auth_failures (
  key TEXT PRIMARY KEY,
  route_group TEXT NOT NULL,
  window_start TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_updated ON auth_failures(updated_at);

-- Small key and value store for the Worker's own state: the pulse keeper, retention, and similar.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

-- K9: when the Worker fired the dispatch, why a row failed, and how often it was retried.
ALTER TABLE subagents ADD COLUMN dispatched_at TEXT;

ALTER TABLE subagents ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

-- K3 and A1: the encrypted copy of a key that a person marked "also for chat". AES-256-GCM under CONNECTOR_KEK.
-- The additional data is connectionId|connectorId|kekVersion. This table also holds connector credentials in release 2.
CREATE TABLE IF NOT EXISTS vault_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  kek_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vault_records_scope ON vault_records(scope, owner_id);

-- The event log. The notification router (release 2) and the activity timeline both read it. It holds titles and short
-- text only, never a secret and never personal data.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  source TEXT,
  dedupe_key TEXT,
  routed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);

CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key, at);
