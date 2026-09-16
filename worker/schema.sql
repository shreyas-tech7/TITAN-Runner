-- titan-runner-brain D1 schema.
--
-- Already applied live to the titan-runner-brain D1 database
-- (341c3067-7111-4fd3-8fe5-3e25120f0661) via the Cloudflare API during this
-- build — this file exists so the schema is reproducible from source (e.g.
-- `wrangler d1 execute titan-runner-brain --file=./schema.sql` against a
-- fresh database) and reviewable in the PR diff, not because anything still
-- needs to run it.

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
