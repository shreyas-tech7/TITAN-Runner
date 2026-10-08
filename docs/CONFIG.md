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
| `state/control.json` → `autonomy` | `autonomous` | `dry-run` \| `propose` \| `approval` \| `autonomous`. Set with `titan control autonomy <level>` or the control workflow, never by env. The safety rules (`config/safety-rules.yml`) sit beneath this: the dial can only make things stricter. |
| `state/control.json` → `killSwitch`, `drain`, `safeMode` | `false` | Same. Safe mode forbids external effects at every level. |
| `TITAN_TOOLS` | on | `off` gives steps no tools at all. |
| `TITAN_MAX_TOOL_CALLS_PER_STEP` | `6` | Tool rounds one step may make; more is a loop. |
| `TITAN_EGRESS_ALLOWLIST` | empty | Hosts `http_fetch` may reach: `api.example.com, .docs.example.com`. Empty allows nothing. https only, public addresses only, no redirects. |
| `TITAN_VERIFY_JUDGE` | `1` | `0` skips the judge model (deterministic checks only, recorded as unjudged). |
| `TITAN_VERIFY_STRICT` | `0` | `1` fails a run that could not be judged. |
| `TITAN_MAX_REMEDIATIONS` | `1` | Times a failed verification sends the steps at fault back with feedback. |
| `TITAN_REVIEWER` | `1` | `0` disables the Reviewer Gate. Do not. |
| `TITAN_REVIEWER_TIMEOUT_MS` | see `src/config.js` | Reviewer model call deadline. |

## Safety rules, research, Hermes

| Variable | Default | Meaning |
|---|---|---|
| `config/safety-rules.yml` | shipped | Per-category `auto_approve` / `always_ask` / `default`. `git-commit`, `file-delete`, `credential-change`, `state-mutation` always ask regardless. Read once per pulse; a missing or malformed file falls back to identical built-in rules. See `docs/RUNTIME.md` "Safety rules". |
| `config/research-topics.yml` | shipped | The standing topics for the daily research digest (`max_topics`, and `topic-id: "what to cover"`). |
| `TITAN_RESEARCH` | on | `0` turns the daily research digest off. |
| `TITAN_RESEARCH_RETRY_MINUTES` | `180` | After a skipped attempt (every provider limited, empty answer), the soonest the next try may be. |
| `HERMES_<N>_BASE_URL`, `_API_KEY` | unset | Hermes agent instance N (1..3). https only; an instance without a key is never called. Client code only — see `docs/RUNTIME.md` "Hermes agent cluster". |
| `HERMES_<N>_SPECIALIZATION` | empty | Comma-separated task aspects (`src/orchestrator/taxonomy.js`); empty = generalist. |
| `HERMES_<N>_MODEL`, `_CHAT_PATH`, `_NAME` | `hermes-agent`, `/v1/chat/completions`, `hermes-<N>` | Optional per-instance overrides. |

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

## Worker (Wave 12)

These are variables and secrets of the `titan-runner-brain` Worker, not of the pulse.

| Name | Kind | Meaning |
|---|---|---|
| `TITAN_ADMIN_TOKEN` | secret | The token for people. It opens the `admin` routes. |
| `GITHUB_PAT` | secret | A fine-grained token. It needs Secrets (read and write), Contents (read and write), Issues (read and write), Actions (read), and Variables (read). |
| `CONNECTOR_KEK` | secret | The vault key, 32 random bytes as hex. A workflow makes it. Do not set it by hand. |
| `GEV_SIGNING_KEY` | secret | The signing key for the God's Eye View tab. |
| `TITAN_ALLOWED_ORIGINS` | variable | More CORS origins, separated by commas. The defaults are the Pages origin and the two local origins. |
| `DASHBOARD_URL` | variable | The address of the dashboard. OAuth sends a person back here. |
| `TITAN_COMMIT`, `TITAN_BUILD_TIME` | variable | Set by `worker-deploy.yml` with `--var`. `GET /version` shows them. |
| `TITAN_TEST_MODE`, `TITAN_TEST_HOST_MAP`, `TITAN_PROVIDER_CHECK_TIMEOUT_MS` | test only | Local tests only. Never set them in `wrangler.toml`. A CI check fails if you do. |

### Repo secrets and variables used by workflows

| Name | Kind | Meaning |
|---|---|---|
| `TITAN_CALLBACK_TOKEN` | secret | The Worker makes it and writes it. Workflows send it as `X-Titan-Callback`. |
| `TITAN_ADMIN_TOKEN` | secret | A script sends it only when the callback token is empty. |
| `TITAN_WORKER_URL` | variable | The address of the Worker. |
| `OPENCODE_MODEL` | secret | An optional pin for the OpenCode model. |
| `CUSTOM_1_*` to `CUSTOM_3_*` | secret | A custom OpenAI compatible provider: `API_KEY`, `BASE_URL`, `MODEL`, and `LABEL`. |
| `HERMES_1_*` to `HERMES_3_*` | secret | A Hermes agent: `API_KEY`, `BASE_URL`, `MODEL`, `CHAT_PATH`, and `SPECIALIZATION`. |

The full list of provider secrets is generated from `config/providers.catalog.json` into `.env.example`.

### Retention of D1 rows

The 6-hour cron removes old rows with these limits:

| Table | Limit |
|---|---|
| `connector_calls` | 30 days |
| `auth_failures` | 1 day |
| `oauth_states` | when they expire |
| chat messages and threads | 30 days by default. The setting `retention.chatDays` changes it. |
| `key_events` | 365 days |
| `events` | 30 days |
| `callback_pings` | 30 days |
| `subagents` with status `done` | 90 days |
| `subagents` with status `failed` | 180 days |
| revoked rows in `worker_tokens` | 30 days |

