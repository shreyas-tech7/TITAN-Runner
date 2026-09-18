# Configuration reference

Every knob the engine reads, with its default. All are environment
variables; in GitHub Actions the secrets are repository **secrets** and the
allowlists are repository **variables** (`.github/workflows/titan-pulse.yml`).
Nothing here is required: a missing value is the default, a missing provider
key makes that provider `not_configured`, and the pulse still runs.

## Providers (secrets)

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY`, `TOGETHER_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `HF_API_KEY`, `OPENCODE_API_KEY` | unset | Free-tier keys. Unset = provider reports `not_configured`. |
| `*_MODEL` (per provider) | discovered | Pin a model id; otherwise the last self-test's discovery is used. |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen` | OpenCode gateway. |
| `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL` | unset | Optional self-hosted gateway, tried first for `auto` requests when set. |
| `FREEBUFF_API_KEY` | unset | Accepted, never used (no public API). |

## Intake and authorization

| Variable | Default | Meaning |
|---|---|---|
| `TITAN_TASK_AUTHORS` | empty | Comma-separated GitHub logins allowed to file tasks besides the owner. Bots never. `src/security/authorization.js`. |
| `TITAN_TRUST_COLLABORATORS` | `1` | `0` trusts only the owner and `TITAN_TASK_AUTHORS`; otherwise `author_association` OWNER/MEMBER/COLLABORATOR is trusted. |
| `TITAN_MANUAL_TASK` | unset | A one-off task from `workflow_dispatch`. |
| `TITAN_MAX_TASKS_PER_PULSE` | `3` | Tasks one pulse may claim. |
| `TITAN_MAX_SUBTASKS_PER_RUN` | `8` | Steps a plan may have. |
| `TITAN_TASK_MAX_ATTEMPTS` | `3` | Attempts per step before the retry policy gives up or parks. |
| `TITAN_TASK_TIMEOUT_MS` | `120000` | Wall-clock deadline for one model call. |

## Reliability and budgets

| Variable | Default | Meaning |
|---|---|---|
| `TITAN_PULSE_BUDGET_MS` | `420000` (workflow) / 7 min | Time a pulse may spend; it drains before this and parks tasks on `waiting(pulse-budget)`. |
| `TITAN_PULSE_MAX_MODEL_CALLS` | `120` | Model calls (adapter level) one pulse may make; it drains and stops claiming at the ceiling. |
| `TITAN_TASK_MAX_MODEL_CALLS` | `40` | Per task, across pulses. Exceeding it dead-letters the task (`TASK_BUDGET`). |
| `TITAN_TASK_MAX_TOKENS` | `200000` | Per task, across pulses. |
| `TITAN_TASK_MAX_WALL_MS` | `3600000` | Active processing time per task, across pulses. |
| `TITAN_MAX_PARKS` | `6` | Times a task may park on `provider`/`quota` before it is dead-lettered (`PARK_CEILING`). Ladder: 5 m, 15 m, 30 m, 60 m, 3 h. |
| `TITAN_LEASE_TTL_MS` | `300000` | Lease on a running task; a dead pulse's task is reclaimed after this. Keep it below the cron gap. |
| `TITAN_QUOTA_<PROVIDER>_PER_MINUTE`, `_PER_DAY` | see `src/reliability/quota.js` | Per-provider call ceilings the ledger enforces before a call. |
| `TITAN_EVENTS_RETENTION_DAYS` | `14` | Daily event files kept before compaction to counts. |
| `TITAN_TASK_RETENTION_DAYS` | `30` | Terminal tasks older than this move to `state/archive/`. |
| `TITAN_MAX_RUN_FILES` | `60` | Run records kept under `state/runs/`. |

## Autonomy, tools, verification

| Variable | Default | Meaning |
|---|---|---|
| `state/control.json` → `autonomy` | `autonomous` | `dry-run` \| `propose` \| `approval` \| `autonomous`. Set with `titan control autonomy <level>` or the control workflow, never by env. |
| `state/control.json` → `killSwitch`, `drain`, `safeMode` | `false` | Same. Safe mode forbids external effects at every level. |
| `TITAN_TOOLS` | on | `off` gives steps no tools at all. |
| `TITAN_MAX_TOOL_CALLS_PER_STEP` | `6` | Tool rounds one step may make; more is a loop. |
| `TITAN_EGRESS_ALLOWLIST` | empty | Hosts `http_fetch` may reach: `api.example.com, .docs.example.com`. Empty allows nothing. https only, public addresses only, no redirects. |
| `TITAN_VERIFY_JUDGE` | `1` | `0` skips the judge model (deterministic checks only, recorded as unjudged). |
| `TITAN_VERIFY_STRICT` | `0` | `1` fails a run that could not be judged. |
| `TITAN_MAX_REMEDIATIONS` | `1` | Times a failed verification sends the steps at fault back with feedback. |
| `TITAN_REVIEWER` | `1` | `0` disables the Reviewer Gate. Do not. |
| `TITAN_REVIEWER_TIMEOUT_MS` | see `src/config.js` | Reviewer model call deadline. |

## Runtime and simulation

| Variable | Default | Meaning |
|---|---|---|
| `TITAN_STATE_DIR` | `./state` | The state directory the engine reads and writes. |
| `TITAN_CHECKPOINT` | `none` (`git` in the workflow) | `git` commits and pushes `state/` at step boundaries. |
| `TITAN_DRY_RUN` | unset | `1`: no network, no GitHub writes, offline fixtures. |
| `TITAN_NETWORK` | unset | `off`: every real network call throws (set automatically with the fakes). |
| `TITAN_ECHO_EVENTS` | unset | `1` prints every event as it is appended. |
| `TITAN_FAKE_PROVIDER`, `TITAN_FAKE_GITHUB`, `TITAN_FAKE_LOG_DIR`, `TITAN_FAKE_PULSE_INDEX` | unset | The simulation fakes (`src/fakes/`). `titan simulate` sets them. |
| `TITAN_CLOCK_OFFSET_MS` | `0` | Moves the engine clock; honoured only while the fakes are wired. |
| `TITAN_CONTROL_ACTOR` | local user | Who a control action is attributed to (the workflow passes `github.actor`). |
