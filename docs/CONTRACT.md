# Shared contract, version 1

This file is the source of truth for the contract between TITAN-Runner and TITAN. Changes are additive only and bump the version number. The text below is the contract, word for word.

SHARED CONTRACT V1 (TITAN and TITAN-Runner use this exact text)

* Boundary: TITAN-Runner is public. It only sees provider names, model names, counts, timings, statuses, scores, and host names. TITAN never sends it personal data or secrets.
* Auth: every /ops route on the Runner Worker needs the header Authorization: Bearer OPS_TOKEN. OPS_TOKEN is one random secret that Shreyas sets on both sides.
* POST /ops/usage takes one record or an array of them: { source: "titan" or "runner", provider, model, requests, tokens_in, tokens_out, status: "ok", "error", or "rate_limited", ts (ISO 8601), remaining_requests (optional), remaining_tokens (optional) }.
* GET /ops/quota returns, per provider and model: limit_day, used_day, limit_month, used_month, remaining_pct, resets_at, exhausted, limit_source (a URL), and limit_confidence ("official", "observed", or "unknown"). exhausted turns true at 95% of a known limit, or after a 429 until resets_at.
* GET /ops/health returns, per provider and model: status ("healthy", "degraded", "down", or "not_configured"), latency_ms, checked_at, and error_class.
* GET /ops/eval returns, per model and taxonomy category: score (0 to 1), tasks_run, run_at, and eval_version.
* GET /ops/hosts returns, per host name (never URLs): status ("up", "asleep", or "down"), last_check, uptime_24h, uptime_7d, and uptime_30d. The GitHub Actions entry also has last_pulse_at.
* Public mirrors with the same shapes and nothing secret: health.json, quota.json, eval.json, and hosts.json at https://raw.githubusercontent.com/shreyas-tech7/TITAN-Runner/main/state/ops/. TITAN reads these when the Worker is down.
* Doorbell: Runner's schedule workflow sends POST {TITAN_BACKEND_URL}/api/scheduled/{job} with Authorization: Bearer DOORBELL_TOKEN and no body. Jobs: digest (06:30 America/Chicago daily), weekly-review (Sunday 18:00 America/Chicago), and sweep (every 15 minutes). TITAN_BACKEND_URL and DOORBELL_TOKEN live only in Runner's Actions secrets and TITAN's env.
* Routing rules for both routers: skip providers that are down, not_configured, or exhausted. Rank degraded ones last. Trip a circuit breaker after 3 straight failures and probe again after 15 minutes. When nothing is available, queue the task and show why.
* Changes: docs/CONTRACT.md in TITAN-Runner is the source of truth. Changes are additive only and bump the version number.

## How this repo builds to the contract

The sections below explain the choices that the contract leaves open. They add detail. They do not change the contract.

### Shapes of the answers

Each `GET /ops/*` route answers one JSON object. The object carries `contract` (the string `"1"`), `generated_at` (ISO 8601), and the data under one key. Keys that the contract names are in snake case, as written above.

| Route | Data key | Shape |
|---|---|---|
| `GET /ops/quota` | `providers` | `{ <provider>: { <model>: { limit_day, used_day, limit_month, used_month, remaining_pct, resets_at, exhausted, limit_source, limit_confidence } } }` |
| `GET /ops/health` | `providers` | `{ <provider>: { <model>: { status, latency_ms, checked_at, error_class } } }` |
| `GET /ops/eval` | `models` | `{ <model>: { <taxonomy category>: { score, tasks_run, run_at, eval_version } } }` |
| `GET /ops/hosts` | `hosts` | `{ <host name>: { status, last_check, uptime_24h, uptime_7d, uptime_30d } }`. The entry `github_actions` also holds `last_pulse_at`. |

A limit that the docs do not state is `null` and its `limit_confidence` is `"unknown"`. Runner never guesses a limit. If no official page exists for a provider, such as a gateway or a server that the owner runs, `limit_source` is `null`.

The four public mirrors (`state/ops/health.json`, `quota.json`, `eval.json`, `hosts.json`) hold the same objects. `POST /ops/usage` answers `{ accepted, duplicates }`.

### Added routes

These routes are additive. TITAN does not need them.

| Route | Who calls it | Purpose |
|---|---|---|
| `GET /ops/usage` | A person or TITAN | The daily totals that the quota meter reads. |
| `POST /ops/health` | The nightly canary workflow | Stores the canary results. |
| `POST /ops/eval` | The weekly eval workflow | Stores the eval scores. |
| `POST /ops/hosts` | The host probe workflow | Stores the host checks. |
| `POST /ops/doorbell` | The doorbell workflow | Stores the status code of each doorbell call. No body is kept. |

Every route above needs `Authorization: Bearer OPS_TOKEN`. A request without it gets `401`.

### Reset rules

Each provider has its own reset rule in `config/quotas.json`. If the docs of a provider do not state a rule, the rule is UTC midnight. `resets_at` is the next reset of the day limit. After a `429` the model stays exhausted until `resets_at`.
