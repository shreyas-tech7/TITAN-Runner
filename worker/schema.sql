-- titan-runner-brain D1 schema.
--
-- Applied live to the titan-runner-brain D1 database
-- (341c3067-7111-4fd3-8fe5-3e25120f0661) via the Cloudflare API during this
-- build (verified directly: the database had zero tables before this pass,
-- despite an earlier version of this comment claiming otherwise — re-run
-- `wrangler d1 execute titan-runner-brain --remote --file=./schema.sql`
-- yourself if you ever need to confirm live state again) — this file exists
-- so the schema is reproducible from source and reviewable in the PR diff.

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
  run_url TEXT
);

CREATE TABLE IF NOT EXISTS provider_keys_meta (
  provider TEXT PRIMARY KEY,
  configured INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subagents_status ON subagents(status);
CREATE INDEX IF NOT EXISTS idx_subagents_source ON subagents(source);

-- Seed rows for the five adapters this repo already has (task brief,
-- section 3: "Do not write new adapters"). configured stays 0 until a real
-- key is posted through POST /admin/keys.
INSERT OR IGNORE INTO provider_keys_meta (provider, configured, updated_at) VALUES
  ('groq', 0, NULL),
  ('together', 0, NULL),
  ('openrouter', 0, NULL),
  ('gemini', 0, NULL),
  ('huggingface', 0, NULL);

-- ---------------------------------------------------------------------
-- OmniRoute gateway telemetry (phase 1). `subagents.provider` already
-- distinguishes 'omniroute' from a direct provider id whenever it was
-- actually used (see src/providers/registry.js); this column adds the
-- per-run token count so the dashboard's OmniRoute Status panel can show
-- real routed-vs-direct counts and a real (not invented) token total,
-- rather than a fabricated "savings" percentage.
-- ---------------------------------------------------------------------
ALTER TABLE subagents ADD COLUMN tokens_used INTEGER;

-- ---------------------------------------------------------------------
-- Phase 2: OSINT tool catalog + owner-gated investigation log.
--
-- osint_tools is read-only reference data ingested once from a public
-- awesome-list (POST /admin/osint/ingest, admin-token-gated) — just tool
-- metadata (name/category/url/description), nothing that runs anything by
-- itself.
--
-- osint_investigations and geospatial_events are the part that actually
-- matters for abuse-resistance: TITAN-Runner accepts tasks from public,
-- unauthenticated GitHub issues (see README's Security section), and this
-- repo's whole design principle is "nothing world-readable happens without
-- going through the Reviewer Gate." An investigation row (and therefore
-- every geospatial_event that can ever exist) is created ONLY by
-- POST /osint/investigate, which requires the same X-Titan-Auth admin
-- token every other write route already requires — never reachable from
-- mirrorGithubIssues(), which hardcodes task_type='auto' for every
-- github-issue-sourced row (see index.js). POST /internal/geospatial-event
-- re-checks source='dashboard' AND task_type='osint' on the linked
-- subagents row before it will ever write a pin — a second, independent
-- gate, not just "the mirror happens not to set this today."
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Phase 4: "Learn anything" fallback.
--
-- learn-anything.xyz has no public API and no queryable structured graph
-- — checked directly against its source (github.com/learn-anything/
-- learn-anything.xyz) while building this: the repo is a placeholder
-- (readme + one stub file, explicitly "not open source yet"). Same
-- Freebuff-shaped situation docs/RUNTIME.md already documents for this
-- codebase: don't wire up a call to something that isn't there. Instead
-- run-subagent-task.mjs builds the dependency tree the same way
-- capabilityRegistry.js already builds capability probes — a structured
-- JSON prompt to this cluster's own configured provider — which is the
-- honest equivalent of the brief's intent using a mechanism this repo
-- already trusts.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS learning_paths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subagent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  tree TEXT NOT NULL, -- JSON: {topic, prerequisites:[{topic,reason}], resources:[string]}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_paths_subagent ON learning_paths(subagent_id);

-- ---------------------------------------------------------------------
-- Phase 5: Hermes self-improvement loop (worker/src/meta-agent.js).
-- system_memory holds the active "lessons learned" every future sub-agent
-- task prepends to its context; system_memory_audit is the full diffable
-- history of every mutation the meta-agent makes to it — old value, new
-- value, timestamp, triggering task — so a drift in what it's teaching
-- future tasks is debuggable after the fact, not just observable.
-- ---------------------------------------------------------------------
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
  action TEXT NOT NULL, -- 'created' | 'deactivated'
  old_value TEXT,
  new_value TEXT NOT NULL,
  triggering_task_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_memory_audit_memory_id ON system_memory_audit(memory_id);
