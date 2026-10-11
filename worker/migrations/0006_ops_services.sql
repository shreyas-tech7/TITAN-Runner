-- Daily assistant run, RO1 to RO6: the shared ops services (contract v1, docs/CONTRACT.md).
-- Additive only: new tables and new indexes. Nothing is dropped or renamed.
-- These tables hold provider names, model names, counts, timings, statuses, scores, and host names. Nothing else.

-- RO1: the usage ledger. One row for each record that TITAN or Runner reports. `dedupe` is a hash of the record, so the
-- same record sent twice counts once.
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  status TEXT NOT NULL,
  ts TEXT NOT NULL,
  remaining_requests INTEGER,
  remaining_tokens INTEGER,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_log_pm_ts ON usage_log(provider, model, ts);
CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log(ts);

-- RO1: what a provider told us. A 429 holds the model until the next reset. A header that counts a whole day
-- shows the real daily limit.
CREATE TABLE IF NOT EXISTS quota_state (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  blocked_until TEXT,
  last_429_at TEXT,
  observed_remaining_requests INTEGER,
  observed_remaining_tokens INTEGER,
  observed_at TEXT,
  used_day_at_observation INTEGER,
  PRIMARY KEY (provider, model)
);

-- RO2: the latest canary result of each provider and model.
CREATE TABLE IF NOT EXISTS ops_health (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at TEXT NOT NULL,
  error_class TEXT,
  PRIMARY KEY (provider, model)
);

-- RO3: the latest eval score of each model and taxonomy category.
CREATE TABLE IF NOT EXISTS ops_eval (
  model TEXT NOT NULL,
  category TEXT NOT NULL,
  score REAL NOT NULL,
  tasks_run INTEGER NOT NULL,
  run_at TEXT NOT NULL,
  eval_version TEXT NOT NULL,
  PRIMARY KEY (model, category)
);

-- RO5: the latest status and uptime of each host. The table holds host NAMES. A URL never goes into D1.
CREATE TABLE IF NOT EXISTS ops_hosts (
  host TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_check TEXT NOT NULL,
  uptime_24h REAL,
  uptime_7d REAL,
  uptime_30d REAL,
  last_pulse_at TEXT,
  updated_at TEXT NOT NULL
);

-- RO6: the status code of each doorbell call. No body and no answer text.
CREATE TABLE IF NOT EXISTS doorbell_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status_code INTEGER,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doorbell_log_at ON doorbell_log(at);
