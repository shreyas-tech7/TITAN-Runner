# Daily assistant: state of the repo before the run

This file records what the repo looked like at the start of the daily assistant run. Date: 2026-10-11. Branch: `claude/daily-assistant`, cut from `main` at commit `00cc4da`. Read `docs/DAILY_ASSISTANT_PROGRESS.md` for what is done.

## Live URLs

- Pages site: https://shreyas-tech7.github.io/TITAN-Runner/ (HTTP 200, deploys from `pages-deploy.yml`).
- Worker: https://titan-runner-brain.titan-runner.workers.dev (schema version 4, deploys from `worker-deploy.yml`).
- Public mirror root: https://raw.githubusercontent.com/shreyas-tech7/TITAN-Runner/main/state/

## Baseline

| Check | Result |
|---|---|
| Root tests (`node --test test/*.test.js`) | 405 pass, 0 fail |
| Worker tests (`npm run test:worker`, real workerd included) | 235 pass, 0 fail |
| Dashboard tests (`cd dashboard && npm test`) | 93 pass, 0 fail |
| Dashboard typecheck (`npx tsc --noEmit`) | clean |
| Dashboard build (`npm run build`, Next.js 15.5) | passes in 36 seconds, 11 static pages |
| `node scripts/check-all.mjs` | every step passes |
| Lint | No ESLint. The static checks in `check-all` are the lint gate. |
| gitleaks on full history (1,077 commits, all branches) | 20 hits, all fake test values |
| gitleaks on Issue, PR, and comment text (65 items) | 0 hits |

The 20 history hits sit in five test files and two fixtures. Example: the Slack fixture value is `TESTVALUENOTAREALSECRET00`. No real key is in the history.

## Workflows

| File | Triggers | Writes to `state/` | Group |
|---|---|---|---|
| `titan-pulse.yml` | cron every 15 min, `repository_dispatch` (the Worker keeper), manual | yes | `titan-pulse` |
| `titan-control.yml` | manual | yes | `titan-pulse` |
| `provider-selftest.yml` | cron daily and weekly, `repository_dispatch`, manual | yes | `provider-selftest-*` |
| `keepalive.yml` | cron weekly, manual | yes | none |
| `deadman.yml` | cron daily, manual | no | none |
| `ci.yml` | push to main, pull request | no | none |
| `pages-deploy.yml` | push to `dashboard/**`, cron daily, manual | no | `pages` |
| `worker-deploy.yml` | push to `worker/**`, manual | no | `worker-deploy` |
| `vault-provision.yml`, `gev-provision.yml` | manual (gev also on its own file) | no | `worker-deploy` |
| `spawn-subagent.yml`, `vm-agent.yml` | `repository_dispatch` | no | per task |
| `callback-ping.yml` | `repository_dispatch`, manual | no | `callback-ping` |
| `gev-live-check.yml` | manual | no | `gev-live-check` |

Facts that matter for RT2:

- No workflow uses `issues`, `issue_comment`, or `pull_request_target`. The only outsider trigger is `pull_request` in `ci.yml`. A fork pull request gets no secrets.
- Every `uses:` is pinned to a full SHA. `scripts/check-workflows.mjs` checks pins, `run:` injection, `pull_request_target`, and top-level `permissions`.
- Four workflows write to `state/` and use three different groups (or none). `keepalive.yml` has no group and no rebase before push.
- The pulse keeper commits about every 16 minutes. The repo grows by about 640 commits a week.
- `vm-agent.yml` and `spawn-subagent.yml` pass every provider secret to the job step.
- PR 22 (a draft by the owner) bumps the pins in nine workflows. This run does not edit `uses:` lines, so the two do not conflict.

## Intake and reviewer gate

- `src/security/authorization.js` checks the author of every Issue and comment. It trusts the owner, an allowlist, and GitHub `OWNER`, `MEMBER`, and `COLLABORATOR` associations. It never trusts a bot.
- `src/reviewer/` is the Reviewer Gate. Layer 1 is deterministic. Layer 2 asks a Groq model.
- `ToolRegistry.invoke()` in `src/tools/registry.js` checks the tool exists and checks the arguments against the schema before it runs. It reports the first 3 errors only.
- All GitHub writes in the runner code go through `src/github.js`. The policy engine decides them. The Reviewer Gate does not see them. Worker writes (`repository_dispatch`, secret `PUT`) go through `worker/src/lib/github.js` with no gate.
- Workflow shell steps run `git commit` and `git push` with a fixed script. A model cannot reach them.

## Worker

- Entry: `worker/src/index.js`. Pipeline: `worker/src/app.js`. Route table: `worker/src/routes.js`. Groups: `public`, `admin`, `internal`, `mcp`, `hook`, `oauth`.
- Live probe without a token: every `admin` and `internal` GET route returns 401. A route-table test already fails when a route has no group.
- Public routes: `/`, `/version`, `/gev/jwks`, `/badge/pulse`, two `.well-known` routes, `POST /oauth/mcp/register`, `GET /oauth/mcp/authorize`, `POST /oauth/mcp/token`.
- `POST /oauth/mcp/register` writes a row to D1 with no token and no rate limit. RT5 fixes this.
- Auth today: one static admin token in `X-Titan-Auth`. It has no expiry. The browser stores it in `sessionStorage` or `localStorage`.
- Lockout today: 10 wrong tokens in 10 minutes lock one client (hash of IP) for 15 minutes, per route group. There is no overall limit, no backoff, and no sign-in log.
- CORS today: Pages origin plus `http://localhost:3000` and `http://127.0.0.1:3000`.
- Keys: `POST /admin/keys` seals the key into a GitHub Actions secret. D1 keeps a fingerprint and the last 4 characters. This already meets the key rule.
- D1: database `titan-runner-brain`, migrations in `worker/migrations/` (four files), generated copy in `worker/src/migrations.generated.js`. The Worker applies a missing migration on its first request.
- Cron: `* * * * *` tick and `0 */6 * * *` (retention and meta agent).

## Secrets and variables (names only)

- Actions secrets set: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `GEMINI_API_KEY`, `GROK_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TITAN_ADMIN_TOKEN`, `TITAN_CALLBACK_TOKEN`.
- `GROK_API_KEY` is not in the provider catalog and no workflow reads it.
- Actions variables set: `GEV_URL`, `TITAN_WORKER_URL`.
- Worker secrets used by the code: `TITAN_ADMIN_TOKEN`, `GITHUB_PAT`, `CONNECTOR_KEK`, `CONNECTOR_KEK_PREV`, `GEV_SIGNING_KEY`.
- Not set yet (new in this run): `OPS_TOKEN`, `DOORBELL_TOKEN`, `TITAN_BACKEND_URL`, host URL secrets, an optional Discord webhook.

## Repository settings

- Secret scanning: enabled. Push protection: enabled. Non-provider patterns and validity checks: disabled.
- Dependabot alerts: not enabled (the API answers 404).
- Branch protection on `main`: none. `CLAUDE.md` forbids changing it.
- Open Issues: four weekly digests by the Actions bot. Open PRs: 4 (arena agent), 5, and 22.
- Push access: the `gh` token has scopes `gist`, `read:org`, `repo`. It has no `workflow` scope. GitHub rejects a push that changes a workflow file without it.

## State

- `state/` is 608 KB. It holds events (24 files, 436 KB), digests, views, runs, reviews, and the small JSON files.
- Retention exists for runs (rolled into a daily rollup digest) and events (compacted to a daily archive after 14 days). There are no monthly archives.
- `scripts/check-secrets-in-state.mjs` scans state files with the repo secret patterns. It reads text only.
- `schemas/` holds JSON schemas exported from `src/state/schema.js`. No check forbids extra fields in every state file.

## Dashboard

- Next.js 15 static export in `dashboard/`. `AdminGate` hides the whole page until the admin token is pasted. Demo mode (`?demo=1`) uses fixtures.
- State files load through `usePolledJson` from `raw.githubusercontent.com` first, then from the build copy.
- Existing panels: pulse band, quota, provider health strip, queue, run history, safety research, PR list, cluster panels, VM fleet, connectors, keys, health.

## Provider adapters (for the canary and the eval)

Catalog ids: `groq`, `together`, `openrouter`, `gemini`, `huggingface`, `opencode`, `omniroute`, `hermes_1`, `hermes_2`, `hermes_3`, `freebuff` (no public API), `custom_1`, `custom_2`, `custom_3`.
