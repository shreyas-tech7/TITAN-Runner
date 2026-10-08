# Wave 12: the system as found

Date of the check: 2026-10-08. The brief names 2026-10-06. This file records what a read-only check showed at the start of the run.

Every check used read access only. D1 queries were SELECT statements through the Cloudflare connector. GitHub checks used `gh secret list`, `gh variable list`, and `gh run list`. Public routes were fetched with `curl`. No secret value was read, printed, or stored.

## Result for each item in Section 2.2

| Item | Claim | Result | Evidence |
|---|---|---|---|
| 1 | `provider_keys_meta` has five rows, all `configured = 0` and `updated_at = NULL` | Confirmed | SELECT on the live D1: gemini, groq, huggingface, openrouter, together. All five show `configured = 0` and `updated_at = null`. |
| 2 | Gemini is `ok`. OpenRouter is `rate_limited` with about 84 percent errors. Four others are `not_configured`. | Confirmed, with a small change | `state/providers.json` shows Gemini `ok` (error rate 0.24). OpenRouter is `rate_limited` and its error rate is now 0.945. Groq, Together, HuggingFace, and OpenCode are `not_configured`. |
| 3 | The panel shows "Not configured" for Gemini and OpenRouter, but both secrets exist | Confirmed | `gh secret list` shows `GEMINI_API_KEY` and `OPENROUTER_API_KEY`, both set on 2026-09-03. The panel reads only D1. |
| 4 | `GROQ_API_KEY` is still not set | Confirmed, and the cause may be a typo | `gh secret list` shows `GROK_API_KEY` (set 2026-09-03). It does not show `GROQ_API_KEY`. The name `GROK_API_KEY` is almost certainly a spelling slip. The pulse reads `GROQ_API_KEY` only. See new item 12. |
| 5 | `subagents` has one row with status `dispatched` that never reported back | Confirmed | One row. Source `dashboard`, queued `2026-09-17T03:04:53Z`, status `dispatched`, no start time, no finish time, no provider. |
| 6 | Callbacks use the admin token, and a rotation could break them | Plausible, not proven | `scripts/run-subagent-task.mjs` sends `TITAN_ADMIN_TOKEN` as `X-Titan-Auth`. `TITAN_ADMIN_TOKEN` was last set on 2026-10-02. One `spawn-subagent` run exists (2026-09-24, success). The run succeeded, but the row never changed. A rejected callback would explain this. The Worker logs are not readable from here. |
| 7 | `POST /admin/keys` accepts five providers only | Confirmed | `KNOWN_PROVIDERS` in `worker/src/index.js` lists five ids. The pulse also reads `OPENCODE_*`, `OMNIROUTE_*`, `HERMES_n_*`, and `FREEBUFF_API_KEY`. |
| 8 | No provider check, no runner proof, no remove, no fingerprint, no audit log | Confirmed | Read the code. `handleAdminKeys` seals and writes the secret. It does nothing else. |
| 9 | The sealed box step never ran in production | Confirmed | D1 holds no saved key. The unit test seals in Node only. No test runs in workerd. |
| 10 | The pulse cron asks for 15 minutes but real gaps are about 290 minutes | Confirmed | See the pulse gap table below. |
| 11 | R-10, R-11, and R-12 are open | Confirmed live | A CORS preflight from `https://evil.example` returned `access-control-allow-origin: *`. Twelve wrong tokens in a row on `/status` all returned 401, and none returned 429. One token opens every route in the code. |

## New items found in Phase 0

12. **A secret has a misspelled name.** The repo holds `GROK_API_KEY`. No code reads it. If Shreyas pasted a Groq key under this name, Groq stays `not_configured`. Track K will flag secrets whose names look like a catalog secret with a spelling slip. It will tell Shreyas to save the key again on the Keys page.
13. **The Worker has no migration system.** `worker/schema.sql` is the only record of the schema. The live D1 has no `d1_migrations` table. Track K adds `worker/migrations/` and the deploy step. A baseline migration must be safe to run on the live database, so it uses `CREATE TABLE IF NOT EXISTS` only.
14. **The live `subagents` table already has `tokens_used`.** The `ALTER TABLE` in `schema.sql` already ran. The baseline migration puts `tokens_used` in the `CREATE TABLE` statement, so a fresh database gets the column and the live database is not changed.
15. **Worker tests do not run in CI.** `ci.yml` runs `npm test` at the root and the dashboard tests. It does not run `worker/test`. Track K adds a CI job for them.
16. **TITAN `main` does not hold Wave 10 or Wave 11.** Those pull requests merged into the side branch `claude/titan-wave-10-ismv2y`. TITAN `main` stops at `2602907`, and its `DECISIONS.md` ends at D153. This matches the brief ("start at D154"). The wave-12 branch for TITAN starts from `main`, as the brief says. The side branch also uses numbers D154 and up, so a merge of the two will need a renumber. See the decision log.
17. **The first TITAN test run had nine false failures.** The ignored folder `dashboard/.node-build` held compiled tests from the Wave 11 branch. Their sources do not exist on `main`. A clean rebuild passed all tests.
18. **The local Runner `main` has an old commit.** The local branch `main` in `/workspaces/TITAN-Runner` holds one commit that is not on `origin/main` (`89a02b9`). The branch `wave-12` starts from `origin/main`. The local `main` was not changed.
19. **Public new routes do not exist yet.** `/version` returns 404. The Pages routes `/keys/`, `/connectors/`, `/health/`, and `/chat/` return 404. The Pages root and `/ops/gods-eye/` return 200.

## Pulse gaps

Source: `state/pulse-history.json` on `main`, 60 pulses from 2026-09-26T14:18Z to 2026-10-08T08:02Z.

| Measure | Minutes |
|---|---|
| Smallest gap | 74 |
| Median gap | 303 |
| 90th percentile | 422 |
| Largest gap | 559 |
| Gaps of 20 minutes or less | 0 of 59 |

The cron asks for 15 minutes. GitHub runs it about every 5 hours. The last 12 `titan-pulse` runs all have the event `schedule`. Track R adds a keeper that dispatches the pulse from the Worker.

## Baseline test numbers

| Suite | Command | Result |
|---|---|---|
| Runner root | `npm test` | 342 passed, 0 failed |
| Runner Worker | `cd worker && npm test` | 46 passed, 0 failed |
| Runner dashboard | `cd dashboard && npm test` | 55 passed, 0 failed |
| Runner typecheck | `cd dashboard && npx tsc --noEmit` | clean |
| Runner gates | `check:workflows`, `check:secrets`, `check:schemas`, denylist, diff scan | all clean |
| TITAN lib | `npm run test:lib` | 9 passed, 0 failed |
| TITAN backend | `npm run test:backend` | 710 passed, 0 failed |
| TITAN dashboard lib | `cd dashboard && npm test` (first part) | 249 passed, 0 failed |
| TITAN dashboard components | `cd dashboard && npm test` (second part) | 81 passed, 0 failed |
| TITAN typecheck | `npm run typecheck` | clean |
| TITAN static checks | secrets scan, rebrand, tracked-not-ignored, hardcoded paths, contract | all clean |

The TITAN `npm run smoke` and the Playwright suites are not part of this baseline. Track Q runs them.

## Free tier limits

Checked on 2026-10-08.

| Service | Limit | Source |
|---|---|---|
| Workers Free: CPU time | 10 ms for each request | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers Free: requests | 100,000 each day | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers Free: subrequests | 50 for each invocation | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers Free: cron triggers | 5 for each account | https://developers.cloudflare.com/workers/platform/limits/ |
| D1 Free: rows read | 5 million each day | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 Free: rows written | 100,000 each day | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 Free: storage | 5 GB in total, 500 MB for each database | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 Free: queries | 50 for each Worker invocation | https://developers.cloudflare.com/d1/platform/limits/ |
| D1: bound parameters | 100 for each query | https://developers.cloudflare.com/d1/platform/limits/ |
| GitHub Actions | Free on standard runners for public repositories | https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions |

Two limits shape the design. The Worker may make 50 subrequests and 50 D1 queries in one invocation. The 1-minute tick must stay inside both numbers. The new tick steps (keeper, reaper, schedules, token upkeep) share that budget with the old steps, so each one reads and writes with as few queries as it can.

## Other facts that shape the work

- The Worker is one file of 1,090 lines. Track K splits it into modules and keeps every old export, because the old tests import them.
- The static check `scripts/check-workflows.mjs` forbids `inputs.*` and `github.event.*` inside `run:` scripts. New workflows pass these values through `env:`.
- The static check also forbids unpinned actions. New workflows use the same pinned SHAs as the old ones.
- The Hermes adapter is an agent client, not a chat endpoint. It stays out of the failover order. The catalog marks `hermes_1` to `hermes_3` with `usedBy: ["subagent"]` and a note.
- The dashboard `connect-src` lists only the repo origin, `raw.githubusercontent.com`, `api.github.com`, `api.open-meteo.com`, the Worker, and the God's Eye View host. Decision W12-D10 keeps this list as it is. A test will fail if a new host appears.
- Chromium for Playwright is already in the Codespace cache (`chromium-1234`).
- Node 24.20 runs in the Codespace. CI runs Node 20 for the root tests. The new Worker tests use `node:sqlite` for a real D1 stand-in, so the new CI job uses Node 24.
