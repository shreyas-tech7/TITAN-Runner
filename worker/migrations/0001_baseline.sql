-- 0001 baseline. This file records the schema that the live database already has (worker/schema.sql).
-- Every statement is CREATE ... IF NOT EXISTS, so it changes nothing on the live database and builds the
-- full schema on a fresh one. The live subagents table already has tokens_used, so the column is part of the
-- CREATE TABLE statement here.

CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  source TEXT NOT NULL,
  provider TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_summary TEXT,
  run_url TEXT,
  tokens_used INTEGER
);

CREATE TABLE IF NOT EXISTS provider_keys_meta (
  provider TEXT PRIMARY KEY,
  configured INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subagents_status ON subagents(status);

CREATE INDEX IF NOT EXISTS idx_subagents_source ON subagents(source);

INSERT OR IGNORE INTO provider_keys_meta (provider, configured, updated_at) VALUES ('groq', 0, NULL), ('together', 0, NULL), ('openrouter', 0, NULL), ('gemini', 0, NULL), ('huggingface', 0, NULL);

CREATE TABLE IF NOT EXISTS osint_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  source_list TEXT NOT NULL DEFAULT 'Astrosp/Awesome-OSINT-List',
  ingested_at TEXT NOT NULL,
  UNIQUE(name, url)
);

CREATE INDEX IF NOT EXISTS idx_osint_tools_category ON osint_tools(category);

CREATE TABLE IF NOT EXISTS osint_investigations (
  id TEXT PRIMARY KEY,
  subagent_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  category TEXT,
  tool_used TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_osint_investigations_subagent ON osint_investigations(subagent_id);

CREATE TABLE IF NOT EXISTS geospatial_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  lat REAL,
  lon REAL,
  ip TEXT,
  confidence TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_geospatial_events_recorded_at ON geospatial_events(recorded_at);

CREATE TABLE IF NOT EXISTS learning_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subagent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  tree TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_paths_subagent ON learning_paths(subagent_id);

CREATE TABLE IF NOT EXISTS system_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  lesson TEXT NOT NULL,
  prompt_injection TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  triggering_task_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_system_memory_audit_memory_id ON system_memory_audit(memory_id);

CREATE TABLE IF NOT EXISTS vms (
  id TEXT PRIMARY KEY,
  subagent_id TEXT,
  brief TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  provider TEXT NOT NULL DEFAULT 'railway',
  region TEXT,
  vcpu INTEGER,
  ram_mb INTEGER,
  preview_url TEXT,
  claim_url TEXT,
  build_deadline TEXT,
  claim_deadline TEXT,
  run_url TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);

CREATE INDEX IF NOT EXISTS idx_vms_created_at ON vms(created_at);
