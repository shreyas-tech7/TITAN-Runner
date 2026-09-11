# Changelog

All notable changes to TITAN-Runner are documented here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versioning
is per-increment rather than SemVer for now (this is a continuously-running
system, not a released library); each section is one landed change set.

## [Unreleased]

### Added

- **Post-synthesis verification (roadmap A1)** — a separate, cheap model pass
  judges the merged deliverable against the master prompt before a run is
  stamped complete. Never blocks a task: a failed verdict degrades to
  "complete with caveats", an unobtainable one to "not verified"
  (`src/orchestrator/verifier.js`).
- **Layer-1 prompt-injection & output-hygiene screening (roadmap D1)** — a
  deterministic, warn-only screener for incoming task text and outgoing file
  content, recorded on tasks/run records and logged (`src/lib/promptScreen.js`).
- **Bounded task queue (roadmap E2)** — the oldest finished
  (`complete`/`cancelled`) tasks are archived into a dated digest once past
  `TITAN_MAX_TERMINAL_TASKS` (default 100), so `state/tasks.json` stops
  growing forever without losing history (`src/state/prune.js#pruneTasks`).
- **No-provider graceful degradation (roadmap C6)** — with zero configured
  providers, a live pulse now fails tasks with clear setup guidance instead
  of burning three doomed attempts per task (`src/pulse.js`).
- **Per-run token accounting (roadmap J2)** — every run record now sums
  `tokensUsed` across all attempts plus verification into `tokenUsage`.
- **Deterministic-replay fields (roadmap A5)** — run records now carry
  `promptHash` and `seed` (per-attempt `modelId` was already recorded).
- **Parser fuzzing (roadmap G1)** — a deterministic, dependency-free fuzz
  harness proving the model-output parsers terminate and stay well-shaped on
  adversarial input (`test/parser-fuzz.test.js`).
- **Governance docs (roadmap L2/H4)** — `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, and `docs/ARCHITECTURE.md` plus a
  first ADR.

## [Initial]

- The full pulse: issue intake → Reviewer Gate → decompose → schedule →
  synthesize → comment/close → prune → heartbeat, with the provider layer,
  the three agent pools, the static dashboard, and the CI/denylist/secret-scan
  gates. See the git history for the detailed increments.
