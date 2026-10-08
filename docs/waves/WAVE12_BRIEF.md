# TITAN Wave 12: Keys That Work, Connectors, and a Better TITAN

Brief for Claude Code. Product owner: Shreyas. Date: 2026-10-06.
Repos: `shreyas-tech7/TITAN-Runner` (public, primary) and `shreyas-tech7/TITAN` (private, secondary).

## 0. Rules for this run

You are Claude Code. You will do TITAN Wave 12 from start to finish in this session. Shreyas is the product owner. You are the builder. Shreyas will not read messages from you during the run.

### 0.1 Hard rules

1. Do not ask questions. Nobody will answer them.
2. Do not stop before you complete Section 10. Do not wait for approval.
3. Do not end the session without a deliverable outcome. The minimum outcome is pull requests, a final report, and a handoff prompt.
4. If a decision is not clear, choose the safest default that you can reverse. Record it in the decision log. Then continue.
5. If a human-only step blocks an item, do all the work up to that step. Record the block. Then go to the next item.
6. Report only real results. Do not write "done" for work that you did not run and see pass. If a test fails, say so and show the output.
7. Spend $0. Do not add a card, a paid plan, a paid API, a paid domain, or a trial that becomes paid. Use free tiers only.
8. Never print, log, commit, or echo a secret value. This rule covers API keys, tokens, OAuth secrets, webhook URLs, and bot tokens.
9. TITAN-Runner is public. Its Actions logs, `state/`, issues, and commits are public. Never put personal data there.
10. Never copy vault notes from the private TITAN repo into TITAN-Runner, a log, an issue, or a prompt.
11. Use ASD-STE100 Simplified Technical English for about 80 percent of docs, comments, commit bodies, PR text, and handoff prompts. Section 9 gives the rules.
12. Do not use em dashes or semicolons in any prose that you write.

### 0.2 The only reason to skip an action

Skip one action (not the run) when three conditions are true. The action is destructive. You cannot undo it. The correct choice is not clear. Prepare the action. Write the exact steps in the handoff. Then continue with the next item. Examples:

- Rotate `TITAN_ADMIN_TOKEN`. This would lock Shreyas out of the dashboard.
- Delete a GitHub secret that you did not create in this run.
- Force push to any branch.
- Drop or rename a D1 table or column.
- Change repository settings, branch protection, or the GitHub Pages source.

### 0.3 Resource guard

Earlier TITAN runs used too much memory and made the machine slow. Obey these rules:

- Run one heavy process at a time. A heavy process is a `next build`, a full test suite, or a Playwright run.
- Set `NODE_OPTIONS=--max-old-space-size=1536` for builds and tests.
- Do not leave a watch process or a dev server active after you use it.
- Stop every process that you started before you go to the next phase.
- If free memory is less than 1 GB, stop extra processes first.
- If you use subagents, use one at a time.

### 0.4 Long run rules

This is a long run. Protect the work:

- Commit and push after each item, so that no work is lost.
- Keep `docs/waves/WAVE12_PROGRESS.md` current. After each item, write the item ID, the status, and the next step.
- If your context gets compacted, read `WAVE12_PROGRESS.md` and this brief again before you continue.

## 1. Mission

TITAN must be a tool that Shreyas can use every day, not a demo. This wave has three required outcomes:

1. **Add API key works fully.** The provider checks each key that Shreyas pastes. TITAN saves the key, proves it in a real runner, and then the pulse and the sub-agents use it. The dashboard tells the truth about every key.
2. **Connectors.** Shreyas can connect TITAN to other tools in a few clicks. Other tools, for example Claude Code, can connect to TITAN through MCP.
3. **Everything else works as intended.** Find what is broken today, fix it, and prove it with tests and live checks.

Shreyas also wants many new features. Section 5 lists them. Phase 0 asks you to add your own ideas. Build all of them in priority order.

## 2. The system as found on 2026-10-06

### 2.1 What exists

TITAN-Runner (public) is the live, hosted TITAN. It has these parts:

- A pulse in GitHub Actions (`titan-pulse.yml`, cron every 15 minutes). It runs tasks from issues with the label `titan-task`. It commits its state to `state/`.
- A Cloudflare Worker `titan-runner-brain` (`worker/`) with D1 and a 1-minute cron. It mirrors tasks and dispatches sub-agents. It also holds the provider key route, the VM fleet, the God's Eye View token, OSINT, and system memory.
- Sub-agents. The Worker fires `repository_dispatch` (`spawn-subagent`). `spawn-subagent.yml` runs `scripts/run-subagent-task.mjs`. The script reports back to `/internal/status`.
- A dashboard (Next.js static export) on GitHub Pages at `https://shreyas-tech7.github.io/TITAN-Runner/`. It has an admin token gate, four themes (Eclipse tokens), and a small component kit.
- Free model providers: Groq, Together, OpenRouter, Gemini, and HuggingFace. Also OpenCode, OmniRoute, Freebuff, and a Hermes client.
- A Reviewer Gate, safety rules with a human floor, a daily research digest, and a dead-man workflow.

TITAN (private) is the Obsidian vault plus code. The code is `backend/` (Express), `dashboard/` (Next.js 16), `bin/titan.js`, `lib/`, `render-subs/`, `desktop/` (Tauri HUD), and `sidecars/wake`. Its `/ops` page has a read-only Runner Status panel. Its keys come only from `.env.local`. Shreyas now develops in a GitHub Codespace, not on his own PC. Other live parts are an orchestrator on Hugging Face Spaces, three sub-servers on Render (code in `render-subs/`), and the God's Eye View host on Render.

### 2.2 Evidence: what does not work today

A read-only check on 2026-10-06 found these facts:

1. D1 table `provider_keys_meta` has five rows. All have `configured = 0` and `updated_at = NULL`. No key was ever saved through the dashboard.
2. `state/providers.json` shows Gemini as `ok`. OpenRouter has a key, but its state is `rate_limited`. Its error rate is about 84 percent. Groq, Together, HuggingFace, and OpenCode are `not_configured`.
3. Thus the Provider keys panel shows "Not configured" for Gemini and OpenRouter, but both secrets exist. Shreyas set them by hand in GitHub. The panel reads only D1. It never asks GitHub.
4. A Groq key save on 2026-09-17 failed with "GitHub public-key fetch failed: 403". The PAT got the Secrets permission on 2026-09-24. `GROQ_API_KEY` is still not set.
5. D1 table `subagents` has one row. Shreyas filed it from the dashboard on 2026-09-17. Its status is still `dispatched`. It never reported back. No code moves a stuck row.
6. A probable cause of item 5: workflow callbacks use the same `TITAN_ADMIN_TOKEN` as people. On 2026-09-28 the Actions copy did not match the Worker copy after a rotation. Each callback got a 401.
7. `POST /admin/keys` accepts five providers only. The pulse also reads `OPENCODE_*`, `OMNIROUTE_*`, `HERMES_n_*`, and `FREEBUFF_API_KEY`. The dashboard cannot set them.
8. No step checks a key with the provider. No step proves that a runner can use the key. There is no remove action, no fingerprint, and no audit log.
9. The sealed box step never ran in production. The only real save attempt failed before it. Nobody knows if `tweetnacl-sealedbox-js` works inside the real Workers runtime.
10. The pulse cron asks for 15 minutes. `state/pulse-history.json` shows a median gap of about 290 minutes between real pulses. The data has 60 pulses since 2026-09-24. The longest gap is about 559 minutes. GitHub delays or drops scheduled runs. The "No pulse in N minutes" banner is on most of the time.
11. Three items from `docs/SECURITY-WAVE11.md` are still open:
    - R-10: one token opens all routes.
    - R-11: CORS permits all origins.
    - R-12: nothing limits wrong token attempts.

Note: Do not trust this list without a check. Confirm each item in Phase 0.

## 3. Phase 0: Prepare

Do these steps in this order:

1. Make both repos available. If one is not in your workspace, clone it with `gh repo clone`. If you cannot get the private repo, continue with TITAN-Runner and record the block.
2. In each repo, make the branch `wave-12` from the latest `main`.
3. Save this brief word for word as `docs/waves/WAVE12_BRIEF.md` in both repos. If the brief came as a file, copy that file. Commit it first. Earlier waves lost their brief. Do not let that occur again.
4. Read the files in the read lists below before you change code.
5. Run every test suite. Record the numbers as the baseline. Record each test that fails before you change anything.
6. Confirm each item in Section 2.2. Use read access only for this step. Write the results in `docs/waves/WAVE12_AS_FOUND.md`.
7. Find the free tier limits for Workers CPU time, D1, and Actions minutes on public repos. Record each source URL and the date in `WAVE12_AS_FOUND.md`.
8. Do your own brainstorm. Read the code and docs. Then write at least 25 more improvements that this brief does not name. Give each one a priority (P1 or P2) and a reason. Save the list as `docs/waves/WAVE12_BACKLOG.md`. You will build these items in Track X.
9. Put every item ID from Section 5 into your task list. Update the list as you work.

If you have Cloudflare MCP tools or `gh secret list` in your environment, you may use them to read live state. Use SELECT queries only. Never write to the live D1 by hand. Migrations go through the deploy workflow.

Read list for TITAN-Runner:

- `README.md`, `docs/RUNTIME.md`, `docs/RUNBOOK.md`, `docs/CONFIG.md`, `docs/DATA_CONTRACT.md`
- `docs/SECURITY-WAVE11.md`, `docs/GODS-EYE-VIEW.md`, `docs/runner-upgrade/THREAT_MODEL.md`, `docs/runner-upgrade/DECISIONS.md`
- `worker/src/index.js`, `worker/schema.sql`, `worker/wrangler.toml`, `worker/test/`
- All files in `.github/workflows/`, plus `scripts/run-subagent-task.mjs` and `scripts/provision-railway-vm.mjs`
- `src/providers/`, `src/fakes/`, `src/lib/redact.js`, `src/reviewer/`, `src/policy/`, `src/tools/`, `config/safety-rules.yml`
- `dashboard/app/page.tsx`, the key, cluster, gate, settings, and kit components, `dashboard/lib/workerApi.ts`, `csp.ts`, `secretStore.ts`

Read list for TITAN:

- `CLAUDE.md`, `AGENTS.md`, `dashboard/CLAUDE.md`, `README.md`, `SECURITY.md`
- `docs/ARCHITECTURE.md`, `docs/RUNTIME.md`, `docs/THREAT_MODEL.md`
- The last 30 entries of `DECISIONS.md` (the file is large)
- `backend/config.js`, `backend/services/registry.js`, `backend/routes/runner.js`, `backend/services/runner.js`
- `dashboard/app/ops/page.tsx`, `render-subs/README.md`, `render-subs/server.js`

**Caution:** In TITAN, open only code folders and the files above. Do not open the vault folders `00 Home` through `05 Archive`. You may change only one vault file: append entries to `99 System/Changelog.md`.

## 4. Fixed decisions for this wave

These decisions are final. Do not reopen them. Record each one in the decision log of its repo.

- **W12-D1.** TITAN-Runner is the live product. Build Keys and Connectors there first. TITAN gets parity panels that call the Runner Worker through its own backend.
- **W12-D2.** The Worker is the broker for connectors. Connector credentials stay inside the Worker. D1 stores them encrypted with AES-256-GCM under a key encryption key, `CONNECTOR_KEK`.
- **W12-D3.** A GitHub runner makes `CONNECTOR_KEK` and sends it to the Worker secret store. No person sees it. Copy the pattern of `gev-provision.yml`.
- **W12-D4.** Provider keys keep their current home: GitHub Actions secrets, written as sealed boxes. An optional copy for instant chat goes into the Worker vault. That copy is off by default.
- **W12-D5.** One file is the source of truth for providers: `config/providers.catalog.json`. The Worker, the dashboard, the pulse, `.env.example`, and the workflow env maps must agree with it. A CI gate checks this.
- **W12-D6.** Each token type has one job. The admin token is for people. The callback token is for workflows, and the Worker manages it. MCP tokens are for tools. Hook secrets are for inbound webhooks.
- **W12-D7.** Personal data (mail, calendar, notes, chat) never goes to a public Actions run, `state/`, an issue, or a commit. The Worker handles it. D1 keeps it with retention limits.
- **W12-D8.** D1 changes are additive migrations in `worker/migrations/`. `worker-deploy.yml` applies them before each deploy.
- **W12-D9.** Every new outbound call from the Worker goes through one guard. The guard permits https only, an allowlist of hosts, and public addresses only. It follows no redirects and has a time limit and a size limit.
- **W12-D10.** The browser never calls a new third-party host. New calls go through the Worker. Do not add hosts to the dashboard `connect-src`.

## 5. Work tracks

Do the tracks in this order: K, S, R, C, H, M, T, A, Q, P, X, V. Track D runs through the full wave. Each item has an ID. Use the ID in commit subjects, the PR checklist, and the final report.

### Track K: API keys that work (P0)

**K1. Provider catalog.**
Create `config/providers.catalog.json`. Each entry has these fields:

- `id`, `label`, `kind` (`llm`), `verifiable` (true or false), and `usedBy` (`pulse`, `subagent`, `chat`)
- `secrets`: the key secret name, plus the base URL and model secret names when needed
- `keyHint`: a soft prefix check, for example `gsk_` for Groq. A mismatch gives a warning only.
- `validate`: the method, the URL, the auth style, and the success rule
- `getKeyUrl`, and `freeTierNote` with the date that you checked it

Include these ids: `groq`, `together`, `openrouter`, `gemini`, `huggingface`, `opencode`, `omniroute`, `hermes_1`, `hermes_2`, `hermes_3`, `freebuff`, `custom_1`, `custom_2`, and `custom_3`.

Look up each validation endpoint in the current provider docs. Use Context7 or a web search. Use a call that costs no tokens, such as a model list or a key info route. Record the source URL and the date in `docs/KEYS.md`.

Load the catalog in the Worker, the dashboard, `src/providers/registry.js`, and the scripts. Remove every other hard-coded provider list.

Add `scripts/check-provider-catalog.mjs` and run it in CI. It must fail when a catalog secret is not in the env map of `titan-pulse.yml`, `spawn-subagent.yml`, or `provider-selftest.yml`. It must also fail when a catalog secret is not in `.env.example`.

Acceptance: one catalog exists, the gate passes, and a test proves that the gate fails on drift.

**K2. True key status: `GET /admin/keys`.**
For each catalog provider, return these fields:

- `secretPresent` and `secretUpdatedAt`, from `GET /repos/{owner}/{repo}/actions/secrets` (names and dates only)
- `savedVia`: `dashboard`, or `outside` when the secret exists without a D1 record
- `fingerprint` (the first 12 hex characters of the key SHA-256) and `last4`, for dashboard keys only
- `providerCheck`: the last live check with the provider (result, HTTP class, latency, time)
- `runnerProof`: the last single-provider test in a runner (result, model, latency, time)
- `pulseView`: the entry from `state/providers.json` on `main`, cached for 60 seconds with the Cache API
- `state`: one of `missing`, `saved_unverified`, `provider_ok`, `proven`, `invalid`, `rate_limited`, `unverifiable`, or `error`

If GitHub answers 401 or 403, return a `pat` block with the hint text and the permission name.

Acceptance: after deploy, Gemini and OpenRouter show `secretPresent: true` and `savedVia: outside`. Groq shows `missing`.

**K3. Save and verify: `POST /admin/keys`.**
The body is `{ provider, value, baseUrl?, model?, alsoForChat?, saveIfUnverified? }`. Do the steps in this order:

1. Check the admin token.
2. Check the provider id against the catalog.
3. Check the value format. Keep the current rule: one printable token, 1024 characters maximum. Add the soft prefix hint.
4. If the catalog needs a base URL, check it. It must use https and a public host, with no user name or password in the URL.
5. Check the key with the provider. Use a time limit of 8 seconds.
6. Send the key in a header when the provider permits it. Do not put it in a query string.
7. If the provider rejects the key (401 or 403), return 422 with `provider_rejected` and a short reason. Save nothing.
8. If the provider answers 429, times out, or has no check route, return 202 with `needsConfirm: true`.
9. In the case of step 8, save only when `saveIfUnverified` is true.
10. Seal the value and write the GitHub secret. If Shreyas gave a base URL or a model, write those secrets too.
11. If `alsoForChat` is true and the vault is ready, put an encrypted copy in the vault.
12. Write the D1 metadata: fingerprint, last4, check result, and save time. Never write the key.
13. Write an audit event.
14. Fire `repository_dispatch` with the type `provider-selftest` and the payload `{ provider, requestId }`.
15. Return `{ ok, provider, secretName, fingerprint, last4, providerCheck, selftest: "dispatched", requestId }`.

**Warning:** Never put the key in a response, a log line, an error message, D1, or an audit event. If GitHub fails, return 502 with the current hint text. Do not include the key.

**K4. Remove, replace, test now, audit.**

- `DELETE /admin/keys/:provider` removes the GitHub secrets of that provider and its vault copy. The body must be `{ "confirm": "<provider id>" }`.
- To replace a key, save again. The audit keeps the old fingerprint.
- `POST /admin/keys/:provider/test` fires the single-provider runner test. The result comes back by callback.
- `GET /admin/keys/events?limit=50` lists the audit events: action, provider, fingerprint, result, actor, and time.

**K5. Runner proof.**
Add the `repository_dispatch` type `provider-selftest` to `.github/workflows/provider-selftest.yml`. When the payload names a provider, test only that provider. In this mode, do not commit `state/`. Send the result to a new route, `POST /internal/provider-proof`, with the callback token (K8). The proof is a model list call plus one completion of 8 tokens or less on a free model. Keep the Monday schedule. Map the env vars from the catalog.

**K6. More key types.**

- OpenCode: key, base URL, and model.
- OmniRoute: base URL, key, and model. Check it with `GET {base}/models`.
- Hermes 1 to 3: base URL, key, specialization, model, and chat path. Check each one with the health or model route in `docs/RUNTIME.md`.
- Freebuff: save only. Mark it `unverifiable` and show the reason from the docs.
- Custom 1 to 3: any OpenAI-compatible provider. The fields are label, base URL, key, and model.

For the custom providers, add a generic adapter, `openai_compat`, in `src/providers/`. Put it last in failover. It must use the same breaker, quota ledger, redaction, and Reviewer Gate as the other adapters. Its egress allowlist holds only its own base URL host.

**K7. Keys page in the dashboard.**
Make a new page, `/keys`. Keep a small summary card on the home page. The page has a table with these columns: provider, state, `••••last4`, saved, provider check, runner proof, models, and actions. The actions are "Add or replace", "Test now", "Remove", and "Get a free key". Open each provider page in a new tab with `rel="noopener noreferrer"`.

The add flow in a modal:

1. Shreyas picks a provider. Show only the fields that the catalog asks for.
2. Shreyas pastes the key into a password field. A button shows or hides the value.
3. Show the soft format hint.
4. Shreyas clicks "Save and verify".
5. Show a check mark for each step: format, provider check, seal, GitHub save, and runner test.
6. For the last step, poll `GET /admin/keys` every 5 seconds for up to 3 minutes.
7. If the last step takes longer, say so clearly. Keep the row in `saved_unverified`.
8. On a 422, show "The provider rejected this key" and the short reason.
9. On a 202, show "The provider did not answer. Save anyway?"

Clear the input after each result. Never put a provider key in the URL, `localStorage`, `sessionStorage`, or a log. The "Remember on this device" option never applies to provider keys.

When no key exists, show a short guide: "Add your first key in about one minute." List the free providers that need no card.

**K8. Callback token.**
Callbacks must not depend on the admin token. Do these steps:

1. Add a D1 table `worker_tokens` with `kind`, `token_hash`, `created_at`, `expires_at`, and `revoked_at`.
2. If no callback token exists, the 1-minute tick makes one. It makes 32 random bytes and keeps the SHA-256 hash.
3. The tick then writes the plain value to the Actions secret `TITAN_CALLBACK_TOKEN` as a sealed box. No person sees it.
4. Mark the hash `active` in D1 only after the GitHub write succeeds. If the write fails, the tick tries again after one hour, not sooner.
5. Add `POST /admin/callback-token/rotate` (admin) for a forced rotation. The previous token stays valid for 30 minutes. The route never returns the token.
6. Rotate the callback token every 30 days with the same grace period.
7. All `/internal/*` routes accept the header `X-Titan-Callback`.
8. The routes accept the admin token only in legacy mode. Legacy mode lasts until 30 minutes after the first callback token becomes active. The diagnosis shows legacy mode as a problem.
9. Update `spawn-subagent.yml`, `vm-agent.yml`, `provider-selftest.yml`, and each script that calls back. They send `X-Titan-Callback` from `TITAN_CALLBACK_TOKEN`.
10. The scripts fall back to the admin token only when the callback token is empty.
11. Add a button, "Repair runner callbacks", in Settings and in the Health Center. It rotates the callback token. Then it runs the round trip test.

The round trip test works like this: the Worker fires the `repository_dispatch` type `callback-ping`. A small workflow, `callback-ping.yml`, calls `POST /internal/ping`. D1 records the time. The dashboard shows the result and the seconds that it took. Give `callback-ping.yml` a manual trigger too.

**K9. Stuck task reaper and retry.**
Add `dispatched_at` to `subagents`. In the 1-minute tick, mark a row `failed` when it stays `dispatched` or `running` for more than 25 minutes. Write a clear reason with the probable causes and the fix. Add `POST /tasks/:id/retry` (admin). It sets the row back to `queued` and clears the old result. Add a Retry button and a "Why did this fail?" link to the sub-agent list. After deploy, the row from 2026-09-17 must become `failed` with the reason.

**K10. Secret write round trip.**
Add a diagnosis check. It writes the secret `TITAN_DIAG_PROBE` with a random value. It lists the secrets to see it. Then it deletes it. This check proves that the PAT can write secrets. It never touches a provider key.

**K11. One-time reconcile.**
The first `GET /admin/keys` after deploy fills D1 from the GitHub secret list. Mark those keys `savedVia: outside`. Do not invent a fingerprint for them.

**K12. Tests for Track K.**

- Add unit tests for each step of K3.
- Add integration tests with a fake GitHub API and fake providers. Reuse `src/fakes/` where it fits.
- Run the seal step inside `wrangler dev` (the real workerd runtime), not only in Node. Prove that libsodium opens the sealed box.
- Measure the CPU time of the seal step in workerd. If it uses more than 5 ms, do the X25519 key agreement with WebCrypto. Keep tweetnacl for XSalsa20-Poly1305 and test the result again.
- Add the Playwright scenarios in Section 7.2. All of them must pass.

**Definition of done for Track K.** Shreyas opens `/keys`, pastes a valid Groq key, and clicks "Save and verify". Within 3 minutes, the row shows `proven` with a model name and a latency. The next pulse uses Groq. A new sub-agent task with the type `groq` ends as `done`, and its row shows the provider `groq`. A wrong key shows "The provider rejected this key" and saves nothing.

You cannot do the real key part, because you do not have the key. Prove every link with fakes and local runs. Put the real key check in the list for Shreyas.

### Track S: Security (P0)

**S1. Token scopes.** Put one table of routes and token types in the code and in `docs/RUNTIME.md`. These are the rules:

- The admin token opens `/admin/*`, `/status`, `/tasks`, and the UI data routes.
- The callback token opens `/internal/*` only.
- An MCP token opens `/mcp` only, within its scopes.
- A hook secret opens one `/hooks/:id` only.

**S2. Wrong token lockout (R-12).** Add a D1 table `auth_failures`. Use a SHA-256 hash of the client IP (`CF-Connecting-IP`) and the route group as the key. After 10 failures in 10 minutes, return 429 for 15 minutes. Never store the raw IP. Prune rows older than 1 day. If the Workers rate limit binding is free on this account, you may also use it. Check this first.

**S3. CORS allowlist (R-11).** Allow `https://shreyas-tech7.github.io`, `http://localhost:3000`, and `http://127.0.0.1:3000`. Send `Vary: Origin`. Hook routes and OAuth callback routes need no CORS. `/mcp` accepts requests without an `Origin` header (tools) and requests from the Pages origin.

**S4. One outbound guard.** Write `safeFetch()` in the Worker. Use it for every outbound call. It permits https only, hosts from an allowlist, and public addresses only. It uses `redirect: "manual"`. It has a time limit and a maximum response size. It never logs auth headers.

**S5. Threat model.** Add STRIDE rows to `docs/runner-upgrade/THREAT_MODEL.md` for these parts: keys, the vault, the broker, webhooks, OAuth, MCP, Telegram, chat, and the pulse keeper.

**S6. Secret scan coverage.** Extend the secret scan scripts with new patterns. Add patterns for Telegram bot tokens, Notion secrets, Linear keys, and Slack and Discord webhook URLs. Also add ntfy topic URLs and Google OAuth client secrets. Add a test for each pattern. Keep false positives low.

**S7. Personal data tests.** Prove two rules with tests. First, the broker refuses a callback token call to a `personal` action. Second, no `personal` result can reach `state/` or a workflow log.

### Track R: Reliability (P1, but do R1 early)

**R1. Pulse keeper.** Item 10 in Section 2.2 is the largest reliability problem. Fix it with these steps:

1. Add the `repository_dispatch` type `titan-pulse` to `titan-pulse.yml`. Keep the cron as a backup.
2. Give the pulse job `TITAN_WORKER_URL` and `TITAN_CALLBACK_TOKEN` in its env.
3. At the end of each pulse, call `POST /internal/pulse-heartbeat` with the callback token. If this call fails, the pulse must not fail.
4. In the 1-minute tick, fire a `titan-pulse` dispatch when both of these conditions are true:
    - The last heartbeat is older than 15 minutes.
    - The last dispatch is older than 14 minutes.
5. Before the first heartbeat arrives, read the heartbeat time from `state/heartbeat.json` on `main`.
6. Keep the current concurrency group. It stops two pulses at the same time.
7. Show the real pulse gaps (median and p90 for the last 24 hours) on the dashboard.
8. Change the stale banner so that it uses the keeper state. It must warn only when the keeper fails too.

Acceptance: tests for the keeper rule. After deploy, the median gap goes down toward 15 minutes. Check `state/pulse-history.json` again near the end of the session.

**R2. OpenRouter rotation.** On a 429 for a model, cool that model for 10 minutes. Then try the next free model, with 3 tries maximum in one call. Use the discovered models in `state/providers.json`. Read `render-subs/` in TITAN (PR #16) for the same idea. Prefer Gemini when OpenRouter has more than 50 percent errors in the last hour. Add tests with the fake provider.

**R3. Daily light probe.** Add a daily schedule to `provider-selftest.yml` that only lists models and uses no tokens. Keep the weekly full probe.

**R4. D1 retention.** In the 6-hour cron, prune old rows. Use these limits:

- `connector_calls`: 30 days
- `auth_failures`: 1 day
- `oauth_states`: when they expire
- chat messages: the value in Settings (30 days by default)
- `key_events`: 365 days
- `subagents`: 90 days for `done` rows and 180 days for `failed` rows

Put the numbers in `docs/CONFIG.md`.

**R5. Structured logs.** Write one JSON line for each request. It holds the request id, the route group, the status, the duration, and the token type (never the token). Return `X-Request-Id`. Show the id in UI errors.

**R6. Export and delete.** `GET /admin/export` returns JSON of all D1 tables except vault data and token hashes. `POST /admin/delete-area` deletes chat history, call logs, or audit events after a typed confirm.

### Track C: Connectors hub (P0 core, P1 catalog)

**C1. Manifest format.**
Each connector lives in `connectors/<id>/connector.json`. It has an optional `README.md` and a `fixtures/` folder for tests. Write the JSON Schema in `schemas/connector.schema.json`. A manifest has these fields:

- `id`, `name`, `version`, and `category` (`notify`, `productivity`, `dev`, `data`, `ai`, `automation`, or `custom`)
- `description` (one short sentence), `docsUrl`, and `getKeyUrl`
- `auth`: a `kind` and its `fields`
- `egress`: the allowed hosts. A base URL from Shreyas adds its host after a check.
- `test`: a request and the expected result
- `actions`: a list of actions (see below)
- `triggers` (optional): `webhook` or `poll`

The auth kinds are `none`, `api_key_header`, `api_key_query`, `bearer`, `basic`, `secret_url`, `oauth2_pkce`, `mcp_remote`, and `telegram_bot`. Each field has `name`, `label`, `secret`, an optional `pattern`, and `help`.

Each action has these fields:

- `id` and `title`
- `risk`: `read`, `write`, or `destructive`
- `dataClass`: `public`, `internal`, or `personal`
- a request template, an `input` JSON Schema, an output `pick` list, and a rate limit

Templates use `{{input.name}}` and `{{secret.name}}`. Put secrets only in headers and auth, except for `api_key_query`. URL-encode path values. Build JSON bodies from objects, never from joined strings. Reject unknown fields.

**C2. Vault.**

1. Change `worker-deploy.yml`. Before the deploy, it runs `wrangler secret list`. If `CONNECTOR_KEK` is absent, it makes 32 random bytes in the runner and pipes them to `wrangler secret put CONNECTOR_KEK`. It never prints the value.
2. If `wrangler secret list` fails, do not make a key. Show a warning in the run and continue the deploy.
3. Add `.github/workflows/vault-provision.yml` (manual trigger). It makes the key when the key is absent. It refuses to replace a current key unless the input `rotate` is `yes`.
4. Encrypt with AES-256-GCM through WebCrypto. Use a random 12-byte IV for each record.
5. Use `connectionId|connectorId|kekVersion` as the additional data. Store `iv`, `ciphertext`, and `kek_version`.
6. If `CONNECTOR_KEK` is not set, vault routes return 503 `vault_not_ready` with the fix. The dashboard shows a setup card with the exact steps.
7. Plan for rotation with `CONNECTOR_KEK_PREV` and a re-encrypt route (P2, Track X).

Tests: a round trip works, wrong additional data fails, a changed ciphertext fails, and no key gives 503.

**C3. Broker routes.**

- `GET /connectors` (admin): the catalog and the state of each connection. No secrets.
- `POST /connectors/:id/connect` (admin): check the fields, run the test request, encrypt, store, and return the state. If the test fails, save only with `saveIfUnverified`.
- `POST /connections/:cid/test`, `POST /connections/:cid/rename`, and `POST /connections/:cid/disconnect` (admin).
- Disconnect deletes the vault record. It also removes remote registrations, for example the Telegram webhook.
- `POST /connections/:cid/actions/:actionId` runs an action. See the action steps below.
- `GET /connections/:cid/calls?limit=50` (admin) lists recent calls.

A connector can have more than one connection. Each connection has a `label`.

The action route does these steps:

1. Check the input with the JSON Schema.
2. Apply the risk rules and the data rules.
3. Apply the rate limit.
4. Build the request from the template.
5. Call it with `safeFetch`.
6. Keep only the `pick` fields. Limit the size. Redact.
7. Log metadata to `connector_calls`. Never log the payload.

Risk rules:

- `read`: admin, MCP with `connectors:read`, and the callback token when `dataClass` is not `personal`.
- `write`: admin, and MCP with `connectors:write`. A sub-agent gets `pending_approval`, and the broker puts the call in the Approvals queue.
- `destructive`: admin only, with a typed confirm. Never from a sub-agent or MCP.

**C4. Connectors page, `/connectors`.**

- Show a search box, category chips, and a grid of cards.
- Each card shows an icon, the name, one line of text, the state, and the last test time. The states are Connected, Needs attention, Not connected, and Setup needed.
- Make the connect modal from the manifest fields. Add a "Where do I get this?" link.
- For `secret_url`, explain that the URL is the secret.
- After connect, show the live test result and the latency.
- Add a detail drawer. It shows the connections, Test, Rename, Disconnect, and the actions with risk and data badges.
- In the drawer, a "Try it" form runs `read` actions. Make the form from the JSON Schema.
- The drawer also shows the call log.
- For an inbound webhook, the drawer shows the URL. It shows the secret one time only.
- Add an empty state and a short "How connectors work" text.
- Add command palette entries: "Connect a tool" and "Test all connectors".

**C5. Built-in connectors.**
Build each connector below with a manifest, a test request, its actions, a README with setup steps, and fixture tests. Confirm the current API version of each service in its docs before you write code. All of them must work on a free plan.

| ID | Auth | Test | Actions (risk, data) |
|---|---|---|---|
| `github` | bearer (fine-grained PAT) | get the repo | list issues, list PRs, list runs (read, internal), create issue, comment (write, internal) |
| `telegram` | `telegram_bot` | `getMe` | send message (write, internal), see Track T |
| `discord_webhook` | `secret_url` | GET the webhook URL | send (write, internal) |
| `slack_webhook` | `secret_url` | send a test on click | send (write, internal) |
| `ntfy` | `secret_url`, optional bearer | send a test on click | publish (write, internal) |
| `notion` | bearer, plus the `Notion-Version` header | get the bot user | search, get page, query database (read, personal), append text (write, personal) |
| `todoist` | bearer | list projects | list tasks (read, personal), add task, close task (write, personal) |
| `linear` | API key header | GraphQL `viewer` | list issues (read, internal), create issue (write, internal) |
| `google_calendar` | `oauth2_pkce` | list calendars | list events, free/busy (read, personal) |
| `gmail` | `oauth2_pkce` | get profile | list unread, get message (read, personal), create draft (write, personal) |
| `rss` | none | fetch the feed | latest items (read, public) |
| `open_meteo` | none | forecast | forecast (read, public) |
| `huggingface` | bearer | `whoami-v2` | Space status (read, public) |
| `render` | bearer | list one service | service status, recent deploys (read, internal) |
| `railway` | bearer | GraphQL `me` | service status (read, internal) |
| `webhook_in` | hook secret | none | create a task or an event (see C6) |
| `webhook_out` | `secret_url`, optional HMAC secret | send a test on click | post JSON (write, internal) |
| `rest_custom` | none, header key, bearer, or basic, plus a base URL | GET a test path | request (GET is read, other methods are write), within a path prefix allowlist |
| `mcp_remote` | `mcp_remote` | `initialize` and `tools/list` | each remote tool (risk set per tool, default write), see M3 |

**Warning:** Do not give Gmail a send action. Never ask for the scopes `gmail.send` or `https://mail.google.com/`.

**C6. Inbound webhooks.**

1. When Shreyas connects `webhook_in`, make a `hookId` (16 random bytes) and a secret (32 random bytes).
2. Show the URL `https://<worker>/hooks/<hookId>`. Show the secret one time only.
3. Support three check modes. `hmac` uses the header `X-Titan-Signature: t=<unix>,v1=<hex>` over `t.body`, with a 300 second window and a replay check.
4. `github` uses `X-Hub-Signature-256`.
5. `static` uses the header `X-Titan-Hook-Secret`. The UI marks it as weaker.
6. Map the payload to a sub-agent task (a brief template with `{{body.field}}`) or to an event for the notification router.
7. Limit the body to 64 KB. Limit each hook to 30 calls per minute.
8. Write setup steps for Zapier, Make, n8n, IFTTT, and GitHub webhooks in `docs/CONNECTORS.md`.

**C7. Outbound webhooks and the notification router.**
The events are `task.done`, `task.failed`, `approval.needed`, `key.invalid`, `key.proven`, `callback.broken`, `pulse.late`, `connector.needs_reconnect`, `brief.daily`, and `schedule.fired`.

Add a D1 table `notify_rules`. A rule has an event pattern, connection ids, a minimum severity, quiet hours, and a dedupe window. The default time zone is `America/Chicago`. Send through the `send` or `publish` action of each channel. Do not put personal data in a message unless the rule permits it. Add a rules table and a "Send test" button for each channel in Settings. The pulse sends events through `POST /internal/event` with the callback token.

**C8. OAuth 2 with PKCE.**

1. `POST /oauth/:connectorId/begin` (admin) makes a random `state` and a PKCE verifier. It stores them encrypted for 10 minutes and returns the authorize URL. The dashboard then opens that URL.
2. `GET /oauth/:connectorId/callback` checks `state`. It exchanges the code with the verifier and the client secret, and stores the tokens encrypted.
3. Then the callback redirects to `/connectors?connected=<id>` on the dashboard. The URL holds no token. Put the dashboard URL in a Worker variable, `DASHBOARD_URL`.
4. Refresh the access token when it has less than 2 minutes left.
5. On `invalid_grant`, set the state `needs_reconnect` and send the event.
6. Shreyas pastes the client ID and the client secret into the connect modal. The modal shows the exact redirect URI to register.
7. Scopes: `calendar.readonly` for Calendar. `gmail.readonly` and `gmail.compose` for Gmail.
8. Check the current Google policy for apps in the "Testing" publishing status. Refresh tokens can expire after 7 days in that status. Write the real limit and the options in `docs/CONNECTORS.md`. Show the limit in the modal too.

Test the full flow against a fake OAuth server.

**C9. Sub-agent tool `connector_call`.**
Add this tool to the registry that `scripts/run-subagent-task.mjs` uses. Also add it to the pulse tools if the design fits. It calls the broker with the callback token. A runner gets only `read` actions with `dataClass` `public` or `internal`. A write action returns `pending_approval`. The Reviewer Gate screens the arguments. Results pass through `scrubForState()` before any log line.

**C10. Developer kit.**
Add `npm run connectors:new <id>`. It makes a manifest, a README, and a fixture test. Add `npm run connectors:check`. It checks all manifests and runs the fixture tests. Write `docs/CONNECTORS.md` with the title "Add a connector in 10 minutes".

### Track H: Health and setup (P1)

**H1. Health Center page, `/health`.** Show one row for each part:

- the Worker, D1, the pulse and the keeper, and the Pages build
- the callback round trip and the sub-agent queue (with the stuck count)
- each provider key state and each connector
- the VM fleet and the God's Eye View host
- the Render sub-servers and the Hugging Face orchestrator

Each row shows the state, the last check, the latency, and a "Fix" hint with a doc link or a button. Shreyas enters the health URLs of external services in Settings. Fill in the URLs that the repos already know. The Worker route `GET /health/full` (admin) runs the server checks in parallel. Each check has 6 seconds. The Worker caches the result for 30 seconds.

**H2. Full diagnosis.** Add a "Run full diagnosis" button. It checks these items:

- the Worker version, D1 read and write, and the PAT read access
- the secret write round trip (K10) and the PAT Issues write access (for T4)
- the callback round trip (K8) and the repo variable `TITAN_WORKER_URL`, if the PAT can read variables
- the Pages build age, the vault, each provider, and each connector
- the `/mcp` route, the CORS headers, and the lockout table

It makes a report with a copy button. The report holds no secret.

**H3. Setup checklist.** Show a checklist on the home page until all items are green. The items are:

- The Worker is reachable, and the admin token works.
- The PAT works, and callbacks work.
- The vault is ready.
- Two providers are `proven`.
- One notification channel exists, and one MCP token exists.

Show a progress ring. Each item links to its fix.

**H4. Version route.** Add `GET /version` (public). It returns the service, the commit, the build time, and the schema version. Set the commit at deploy time in `worker-deploy.yml` with `--var`. The dashboard footer shows its own commit and the Worker commit. A mismatch shows a small warning.

### Track M: MCP (P1)

**M1. TITAN as an MCP server.** Add `POST /mcp` to the Worker. Implement the MCP Streamable HTTP transport in stateless mode with JSON responses. Read the current spec at modelcontextprotocol.io first. Pin the protocol version that you implement. `GET /mcp` returns 405. Implement `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. The tools are:

- `titan_status`, `titan_list_tasks`, `titan_get_task`, and `titan_queue_task`
- `titan_keys_status` (no secrets), `titan_connectors`, and `titan_connector_call` (the scope rules apply)
- `titan_notify` and `titan_lessons` (system memory, read)

Auth uses `Authorization: Bearer <MCP token>`. Check the `Origin` header when it is present.

**M2. MCP tokens.** Add a D1 table `mcp_tokens` with these columns: id, label, token hash, scopes, created, last used, and revoked. The UI can create a token, list tokens, and revoke them. The UI shows a new token one time only, with a copy button. The scopes are `status:read`, `tasks:write`, `connectors:read`, `connectors:write`, `personal:read`, `notify:write`, and `chat:write`.

**M3. Remote MCP client.** The connector kind `mcp_remote` connects with `initialize` and `tools/list`. It caches the tools in D1. Each remote tool becomes an action. Shreyas sets the risk of each tool. The default is `write`, so each call needs approval. Support JSON answers and SSE answers. Use a time limit of 20 seconds. Permit egress only to that host.

**M4. "Use TITAN from Claude" card.** Show this Claude Code command template with placeholders. Never show a real token in it.

    claude mcp add --transport http titan <WORKER_URL>/mcp --header "Authorization: Bearer <YOUR_MCP_TOKEN>"

Test the server with the MCP Inspector in CLI mode against `wrangler dev`. Save the output as proof.

Note: The Claude app adds a remote MCP server as a custom connector with OAuth. It has no field for a static header. M5 makes the Claude app path possible. Until M5 is live, the card shows the Claude Code path only.

**M5. OAuth for MCP (P2, Release 3).** Implement the MCP authorization flow from the current spec, so that the Claude app can add TITAN as a custom connector. Do these steps:

1. Read the current MCP authorization spec and the current Claude docs for custom connectors. Record the exact callback URL that the Claude app uses.
2. Serve the protected resource metadata and the authorization server metadata at the paths that the spec requires.
3. Support the client registration method that the spec and the Claude docs need. Permit only allowlisted redirect URIs: the Claude callback URL and `http://localhost` for the Inspector.
4. The authorize route sends Shreyas to a consent page on the dashboard. The page needs the admin token. It shows the client name and the scopes.
5. When Shreyas approves, the Worker issues a code. The token route trades the code (with PKCE) for a short access token and a refresh token.
6. Store only hashes of both tokens. Use the M2 scopes. Show each OAuth client in the MCP token list, with a Revoke button.
7. Test the full flow with the MCP Inspector. Write the setup steps for the Claude app in `docs/MCP.md`.

### Track T: Telegram, two-way (P1)

**T1. Connect.** Shreyas pastes the bot token from BotFather. The Worker calls `getMe`. Then it calls `setWebhook` with the URL `https://<worker>/hooks/telegram/<connectionId>` and a `secret_token`. The Worker checks the header `X-Telegram-Bot-Api-Secret-Token` on each update.

**T2. Pair the owner.** The dashboard shows a one-time pair code that is valid for 10 minutes. Shreyas sends `/pair <code>` to the bot. The Worker saves that chat id as the owner. The bot does not answer other chats. For other chats, the Worker logs metadata only.

**T3. Commands.** Support `/status`, `/task <text>`, `/tasks`, `/approve <key>`, `/deny <key>`, `/brief`, `/keys` (states only), `/chat <text>`, and `/help`. Plain text goes to instant chat (A1) when chat is ready. If chat is not ready, the bot shows a button that makes a task.

**T4. Approvals with buttons.** Approval messages get Approve and Deny buttons. `callback_data` holds a short id plus an HMAC. Telegram permits 64 bytes for it. The Worker checks the owner chat id and the HMAC.

Read `src/policy/` to learn how the pulse keeps an approval that waits. For a pulse approval, the Worker posts `/titan approve <key>` as an issue comment through the GitHub API. This needs the PAT permission Issues: Read and write. If the PAT does not have it, show a clear message. Add the step to the handoff.

**T5. Notifications.** Telegram is one channel of the router (C7).

### Track A: Assistant features (P1)

**A1. Instant chat.**

1. Add `POST /chat` (admin, or MCP with `chat:write`). The Worker calls the provider directly with a vault key that Shreyas marked "also for chat". It streams Server-Sent Events back.
2. Support OpenAI-compatible streams (Groq, OpenRouter, Together, HuggingFace router, custom) and Gemini `streamGenerateContent` with `alt=sse`.
3. On a 429, a 5xx, or a timeout before the first token, try the next provider in catalog order.
4. Keep threads in D1 (`chat_threads`, `chat_messages`) for 30 days by default. Add a delete action for one thread and for all history.
5. Add a "Chat" tab. It shows a thread list, Markdown output (sanitized), a stop button, and a copy button.
6. Each answer shows its provider, its model, and token counts when known. Add a "Make this a task" button.
7. In the browser, use `fetch` with a stream reader, not `EventSource`. The request needs the auth header.
8. Measure CPU time with `wrangler dev`. Keep the work for each chunk small.
9. If a stream goes over the free CPU limit in a test, use non-stream mode for that provider. Set `max_tokens` to 1024 in that mode.
10. If no chat key exists, show a card that explains why. Link the card to `/keys`.

**A2. Schedules.** Add a D1 table `schedules` with these columns: id, label, cron (5 fields), time zone, brief, task type, enabled, last run, and next run. The 1-minute tick queues the due schedules, with 3 per tick maximum. The UI can list, create, edit, pause, and "Run now". Show the next 3 run times in local time. Test the cron parser with time zones and DST changes.

**A3. Daily brief.** Add a built-in schedule at 07:30 `America/Chicago`. It stays off until a channel exists. The Worker writes the brief itself from these parts:

- the weather (Open-Meteo) and the calendar for today (if connected)
- tasks, approvals that wait, and key states
- the title of the latest research digest and one health line

If a chat key exists, add a short summary from the model. Send the brief to the chosen channels. Show it on the home page with a "Read aloud" button (browser `speechSynthesis`). The brief stays in the Worker, because the calendar data is personal.

**A4. Approvals panel.** Show pulse approvals and broker approvals in one panel. Show what each action will do, its risk, and who asked for it. The Approve and Deny buttons work here and in Telegram.

**A5. Activity timeline.** Show one feed of tasks, keys, connectors, approvals, schedules, and deploys. Find deploys from changes in `/version`. Add filters.

### Track Q: Make the current features work (P1)

Test each feature below on a local build with fixtures. Also test it live where you can. Fix what is broken. Add a test for each fix.

1. Task intake: the "+ New task" modal, an issue with the label `titan-task`, and the manual workflow run.
2. The `/titan` commands: cancel, pause, resume, retry, priority, approve, and deny.
3. Autonomy levels, the kill switch, drain, and safe mode.
4. Safety rules and the human floor.
5. The daily research digest.
6. The VM fleet panel and the `vm-agent.yml` callbacks. They use K8 now.
7. The God's Eye View tab and its token flow.
8. The OSINT panel and the geospatial globe.
9. System memory and the meta-agent cron.
10. Themes, the command palette, the PWA install, offline mode, and the weather panel.
11. The stale banner. R1 changes it.

In TITAN, run `npm run preflight` and `npm run smoke`. Fix each failure. Then check these known open items. Fix each one that is still open:

- 16 RunHistory failures in `test-dom`
- the schema check gap in `invokeTool()`
- the orphan supervisor PID after a slow cold boot
- any route that makes a PR without the Reviewer Gate

### Track P: Private TITAN parity (P1)

**P1. Keys panel.**

1. Add `GET /api/keys`. For each provider, it returns: set or not, the source (`env` or `keystore`), the fingerprint, last4, and the last check.
2. Add `POST /api/keys` with `{ provider, value, targets }`. The targets are `local`, `runner`, or both.
3. Copy the catalog to `shared/providers.catalog.json`. Add a drift check that compares it with the Runner copy when both repos are present.
4. Keep a local store, `.titan/keystore.enc.json`, encrypted with AES-256-GCM. Keep the data key in `.titan/keystore.key` with `0600` permissions. Add both files to `.gitignore`.
5. A value in `.env.local` wins over the keystore. The UI shows the source.
6. After a save, rebuild the provider registry in the process. Do not restart.
7. For the `runner` target, the backend calls the Runner route `POST /admin/keys` with `TITAN_RUNNER_ADMIN_TOKEN`. This call occurs on the server. The browser never sees that token.
8. When `TITAN_OFFLINE_BUILD=1`, skip the live check. Say so in the UI.

**P2. Connectors panel.** Add a backend proxy for `GET /connectors` and for `read` actions on the Runner. Show the same cards on `/ops`. Add a backend MCP client that calls the Runner `/mcp` with `TITAN_RUNNER_MCP_TOKEN` from `.env.local`.

**P3. Runner Status v2.** Show the key states, the stuck tasks, the callback health, the vault state, and links to the Runner pages.

**P4. render-subs health.** Make `GET /healthz` return the provider type, the label, the current model, the last discovery time, and the uptime. Never return the key. Add tests. Keep all other behavior.

**P5. Devcontainer.** Add `.devcontainer/devcontainer.json` to both repos with Node 22, `gh`, and the Playwright dependencies. In TITAN, add `customizations.codespaces.repositories` with write access to `shreyas-tech7/TITAN-Runner` for contents, pull requests, and workflows. Shreyas must accept that permission prompt when the Codespace rebuilds. Put that step in his list.

**P6. README reality check.** Describe the real setup of today next to the local path. Name the Codespace for dev, the hosted Runner, the Render sub-servers, and the Hugging Face orchestrator. Keep the local path.

**P7. Changelog.** Append an entry to `99 System/Changelog.md` for each structural change. `CLAUDE.md` requires this.

**P8. Decisions.** Add the decisions of this wave to `DECISIONS.md`. Start at D154.

### Track D: Docs and the documentation standard (P0, through the full wave)

**D1. Documentation standard.** Add `docs/STE.md` with the rules from Section 9 to both repos. Add a "Documentation standard" section to these files:

- TITAN: `README.md`, `CLAUDE.md`, `AGENTS.md`, and `dashboard/CLAUDE.md`
- TITAN-Runner: `README.md`, and a new `CLAUDE.md` that also holds the core rules of that repo

The section says: "Write documentation in ASD-STE100 Simplified Technical English about 80 percent of the time. See docs/STE.md." The section also tells each future agent to obey the same rule in each new doc, comment, commit body, PR text, and prompt.

**D2. STE check.** Add `scripts/check-ste.mjs` to both repos. Run it in CI and in the pre-commit gate. These are its rules:

- It checks Markdown files and Markdown lines that changed in the PR. Old text that did not change gives warnings only.
- It ignores code blocks, inline code, URLs, tables of identifiers, and quotes.
- It fails on an em dash or a semicolon in prose.
- It warns on sentences over 20 words in steps or over 25 words in descriptions.
- It also warns on `-ing` verb forms, contractions, passive voice, and en dashes.
- It prints a score: the percent of changed prose sentences that pass all rules. It fails when the score is below 80.

**D3. Docs to write or update.** Write `docs/KEYS.md`, `docs/CONNECTORS.md`, `docs/MCP.md`, `docs/HEALTH.md`, and a Runner `CHANGELOG.md`. Update the sections that this wave changes in `RUNTIME.md`, `RUNBOOK.md`, `CONFIG.md`, and `DATA_CONTRACT.md`. Rewrite the TITAN-Runner `README.md` fully in STE. Add sections for Keys, Connectors, MCP, Health, and Chat.

**D4. Decision logs.** In TITAN-Runner, use `docs/runner-upgrade/DECISIONS.md` (W12-D1 and up). In TITAN, use `DECISIONS.md` (D154 and up).

### Track X: Your brainstorm (P1 and P2)

Build the P1 items from `WAVE12_BACKLOG.md`. Then build the P2 items. Use these seeds if they fit and are not done yet:

- Global search over tasks, connectors, and docs
- Saved task templates
- A free quota meter for each provider for each day
- An "Explain this failure" button that uses the explain logic of the CLI
- A keyboard shortcut sheet
- A clear banner for safe mode and drain
- A weekly report of what TITAN did, sent to a channel
- Vault key rotation with re-encryption (C2 step 7)

### Track V: Portfolio polish (P2)

**V1. Demo mode.** The URL parameter `?demo=1` shows the dashboard with fixture data and a clear "Demo data" banner. Demo mode never calls the Worker and never asks for a token. Link it from the README.

**V2. Status badge.** Add `GET /badge/pulse` (public). It returns shields.io endpoint JSON with only "up" or "late" and the age in minutes. Add the badge to the README.

**V3. Architecture diagram.** Add one Mermaid diagram to the README. It shows the pulse, the Worker, D1, the sub-agents, the connectors, MCP, and the dashboard.

**V4. "How TITAN works" page.** Add a dashboard page with the same diagram and short STE text.

**V5. Screenshots.** Make new screenshots of each page in demo mode, so that they hold no real data. Save them in `docs/screenshots/wave12/`.

## 6. UI rules

- Use the Eclipse tokens, the four themes, and the component kit. Do not add a new design system.
- Every panel has a state for data that loads, an empty state, and an error state with a next step.
- Labels tell the truth. Write "Saved, not verified" when that is the fact. Never show green for a state that you did not check.
- Every new route passes axe with no violations in all four themes at 1280 px and 390 px. There is no horizontal scroll.
- Support the keyboard, focus rings, and `prefers-reduced-motion`. Use the `useModal` hook for dialogs.
- Add the new pages to the top tabs in this order: Dashboard, Chat, Connectors, Keys, Health, God's Eye View.
- Keep UI text short and clear. Use STE where it fits.

## 7. Verification

### 7.1 Test layers

1. Unit tests for each new function.
2. Integration tests with local fakes. Make fakes for the GitHub API, the providers, the Telegram API, an OAuth server, and an MCP server. Reuse `src/fakes/` where it fits.
3. A local Worker: `wrangler dev` in local mode, with local D1 and all migrations applied.
4. Put test values for the local Worker in `.dev.vars`. Add that file to `.gitignore`.
5. Make the GitHub API base and each provider base configurable for tests only. The flag `TITAN_TEST_MODE` permits `http://127.0.0.1` fakes. Add a CI check that `wrangler.toml` never sets that flag.
6. Dashboard end to end: build the static export with the Pages base path and serve it. Drive it with Playwright Chromium against the local Worker.
7. Accessibility: run axe on every new route, as Section 6 says.
8. Live checks after deploy (7.4).

If you cannot install Chromium, run the same flows with DOM tests. Then mark those items "Done, not verified in a browser".

### 7.2 Track K scenarios (all must pass)

1. With no dashboard keys, the fake GitHub list has Gemini and OpenRouter. After reconcile, they show `savedVia: outside`. Groq shows `missing`.
2. A valid key: each step runs. The fake provider answers 200. The fake GitHub PUT gets a sealed box that opens to the exact key. The dispatch goes out. The proof callback arrives. The row shows `proven`.
3. A wrong key: the provider answers 401. The route returns 422. Fake GitHub gets nothing. The UI shows the message.
4. The provider answers 429. The UI asks "Save anyway?". After the confirm, the row shows `saved_unverified`.
5. The PAT gets a 403 on the public key call. The UI shows the permission name. The message holds no key.
6. Remove: after the typed confirm, fake GitHub gets a DELETE. The row shows `missing`. The event list shows the remove.
7. Legacy callback mode works. After a rotation, the workflows use the new token. The old token works for 30 minutes and then gets 401.
8. A row stays `dispatched` for more than 25 minutes. It becomes `failed` with the reason. Retry sets it to `queued`.
9. Ten wrong tokens give 429. After the window, access works again.
10. Search for the test key value in these places: each response body, a D1 dump, and the Worker console output. Also search the DOM after submit, `localStorage`, `sessionStorage`, and the URL. The value must not occur in any of them.

### 7.3 Other scenarios (all must pass)

1. Connect a fake Discord webhook, test it, and send a message.
2. An inbound webhook with a good HMAC, a bad HMAC, an old timestamp, and a replay.
3. The full OAuth flow against the fake OAuth server, and an `invalid_grant`.
4. The MCP Inspector CLI runs `tools/list` and `tools/call` against `wrangler dev`.
5. The remote MCP client against the fake MCP server, with JSON answers and SSE answers.
6. The broker refuses a callback token call to a `personal` action.
7. A write action from a sub-agent becomes `pending_approval`.
8. The pulse keeper fires when the heartbeat is old. It stays quiet when the heartbeat is fresh.
9. Telegram: pair, `/status`, `/task`, and an approval button with a good HMAC and a bad HMAC.
10. Chat: stream, stop, failover on 429, and thread delete.

### 7.4 Live checks after deploy (public routes only)

- `GET /` answers `ok`.
- `GET /version` shows the merged commit.
- `GET /status`, `GET /admin/keys`, and `POST /mcp` without a token answer 401.
- `POST /hooks/does-not-exist` answers 404.
- A CORS preflight from the Pages origin passes. A preflight from another origin fails.
- The Pages routes `/`, `/keys/`, `/connectors/`, `/health/`, and `/chat/` answer 200.
- The median pulse gap starts to go down toward 15 minutes.

You do not have the admin token. Do not look for it, and do not ask for it. Put each check that needs it into the handoff.

## 8. Git, PRs, releases, and deploy

1. Use conventional commits with the item ID in the subject, for example `feat(keys): K3 save and verify`. Write commit bodies in STE.
2. Before each push, run the full gate:
    - the tests and the typecheck
    - the catalog gate, the manifest check, and the STE check
    - the secret scans, `npm run check:workflows`, and `npm run check:denylist`
3. Open one draft PR per repo early. Keep its checklist current with the item IDs.
4. Ship TITAN-Runner in three releases, so that value goes live early:
    - Release 1: Tracks K, S, and R. Also ship `vault-provision.yml`, `callback-ping.yml`, and the C2 vault key step in `worker-deploy.yml`.
    - Release 2: Tracks C, H, M (without M5), and T.
    - Release 3: Tracks A, Q, X, and V, plus M5.
5. After each release merge, make the next branch (`wave-12-r2`, then `wave-12-r3`) from the new `main`.
6. GitHub runs `workflow_dispatch` only for workflow files on the default branch. Plan for that.
7. If a push of workflow files fails for lack of permission, record it for Shreyas and continue.
8. Merge rule for TITAN-Runner:
    - If every gate is green, every migration is additive, and the secret scan is clean, squash-merge the PR into `main`.
    - Then watch `worker-deploy.yml` and `pages-deploy.yml` with `gh run watch`. Run the live checks in 7.4.
    - If a live check fails, fix it in a new PR in this session, or revert the merge commit. Never leave `main` broken.
    - If a gate stays red and you cannot fix it, keep the PR as a draft. Write the reason in the report.
9. Use the same merge rule for TITAN, with one PR at the end. A change to `render-subs/` can redeploy on Render. After the merge, check each sub-server `/healthz`.
10. Never use `--force` on `main`. Never change branch protection or repository settings.

## 9. Documentation standard (ASD-STE100)

Use these rules for about 80 percent of all text that you write. Code, identifiers, commands, quoted error text, and legal text stay as they are.

1. Use short sentences. Use 20 words or less in a step and 25 words or less in a description.
2. Write one instruction in each sentence. Two actions can share a sentence only when they occur at the same time.
3. Use the imperative for instructions: "Run the tests."
4. Use the active voice.
5. Use simple tenses: present, past, and future with "will".
6. Do not use the `-ing` form of a verb. Technical names are an exception.
7. Keep the articles "a", "an", and "the". Do not write in telegraph style.
8. Use the same word for the same thing in every document. In TITAN, use these words:
    - "key": a provider API key
    - "token": a TITAN access token
    - "secret": a GitHub Actions secret
9. Put a condition before the instruction: "If the test fails, read the log."
10. Use a vertical list for three or more items. Put a colon before the list.
11. Write one topic in each paragraph. Use six sentences or less in a paragraph.
12. Start a warning or a caution with a clear command. Use a note only to give information.
13. Do not use contractions, em dashes, or semicolons.
14. Use noun clusters of three words or less.
15. Do not use slang or filler. Do not use words such as "seamless", "robust", "leverage", "delve", "pivotal", or "testament".

Examples:

| Do not write | Write |
|---|---|
| The key is being validated by the Worker before it gets saved. | The Worker checks the key. Then it saves the key. |
| Don't forget to rotate the token, it's important! | Rotate the token every 90 days. |
| Using the dashboard, keys can be added easily. | Add a key on the Keys page. |
| Webhook setup and testing should be done next. | Make the webhook. Then send a test message. |

## 10. Final deliverables

### 10.1 Final report

Write `docs/waves/WAVE12_REPORT.md` in both repos. Also print the report at the end of the session. Use this structure:

1. Summary: five lines or less.
2. Item table: ID, status, proof, and notes. Proof is a test name, a command with its output, or a URL. Use one of these statuses:
    - "Done and verified"
    - "Done, not verified live"
    - "Blocked on Shreyas"
    - "Not done", with the reason
3. Test numbers before and after, for each suite.
4. Live checks: route, expected result, and actual result.
5. Deploy: PR links, merge commits, and workflow run links.
6. The decisions that you made.
7. Risks and open items.
8. BLOCKED ON SHREYAS: a numbered list. Each item says what to do, where to do it, and why only he can do it.

Only Shreyas can do these kinds of steps:

- Paste a provider key into `/keys`. He starts with the Groq key. Then he adds the other keys that he has.
- Copy an OAuth client ID and client secret into a connect modal.
- Paste a token for a connector, for example Notion, Todoist, Linear, Render, or Railway.
- Make a Telegram bot with BotFather and paste its token.
- Accept the Codespace permission prompt (P5).
- Do any step that needs a password, a 2FA code, or a payment screen.

### 10.2 Handoff prompt for the Claude app

Some steps need a browser or a desktop. Claude Code cannot do them. Shreyas will paste a handoff prompt into the Claude app, which has a browser and computer use. Write that prompt between these two lines:

    ===CLAUDE_APP_HANDOFF_START===
    ===CLAUDE_APP_HANDOFF_END===

The handoff prompt must do these things:

1. Start with context: what Wave 12 did, the PR and deploy links, and the dashboard URL.
2. List the browser tasks in order, with exact pages and expected results.
3. Give the rules to the Claude app (see the list below).
4. End with the instruction for the next Claude Code prompt (see the last paragraph of this section).

Possible browser tasks:

- Run `vault-provision.yml`, `callback-ping.yml`, or `provider-selftest.yml` from the Actions tab with "Run workflow", if they did not run yet.
- Edit the fine-grained PAT of the Worker, named `titan-runner-brain worker`. Add Issues: Read and write, Actions: Read-only, and Variables: Read-only. Do not regenerate the token.
- Open the dashboard in a browser where it is already unlocked. Run "Repair runner callbacks" and "Run full diagnosis". Copy the report.
- Check every new page in all four themes and at phone width. Take screenshots.
- If M5 is live, add TITAN as a custom connector in the Claude app (Settings, Connectors). Use the dashboard consent page only if it is already unlocked.
- In Google Cloud, enable the Google Calendar API and the Gmail API. Do not add a payment method.
- Make the Google Cloud OAuth client up to the screen that shows the client secret. Stop there. Shreyas copies the values.

Rules for the Claude app:

- Shreyas approves each browser task in this list when he pastes the prompt. Still obey your own safety rules.
- Do not ask questions. Do not stop without a deliverable outcome.
- Never type a password, a token, an API key, or a secret. Leave those steps for Shreyas and list them.
- If the dashboard asks for the admin token, skip that check and list it for Shreyas.
- Never add a card or change a payment plan. Spend $0.
- Keep screenshots and the exact error text as proof.
- Write about 80 percent of the text in ASD-STE100.

At the end, the Claude app writes the next Claude Code prompt between `===NEXT_CLAUDE_CODE_PROMPT_START===` and `===NEXT_CLAUDE_CODE_PROMPT_END===`. That prompt gives the context, the items that are now complete, and each failure with its exact error. It tells Claude Code to continue Wave 12 from `docs/waves/WAVE12_REPORT.md`. It tells Claude Code not to ask questions and not to stop without a deliverable outcome. It keeps the same handoff loop until Wave 12 is complete.

Save the handoff prompt as `docs/waves/WAVE12_HANDOFF.md` in TITAN-Runner too. It must hold no secret and no personal data. Print the handoff prompt as the last part of your final message, so that Shreyas can copy it.

## 11. Definition of done

- [ ] The brief, AS_FOUND, BACKLOG, and PROGRESS files are in both repos.
- [ ] Track K is complete, and all ten scenarios in 7.2 pass.
- [ ] The seal step works in workerd, with a CPU measurement in the report.
- [ ] The Keys page is live. Gemini and OpenRouter show `savedVia: outside`.
- [ ] The callback token works. Legacy mode ends 30 minutes after the first token becomes active.
- [ ] The stuck reaper is live. The 2026-09-17 row is `failed` with a reason, or the check is in the handoff.
- [ ] The pulse keeper is live, and the gap trend is in the report.
- [ ] The Connectors page is live with at least 15 connectors that pass their fixture tests.
- [ ] The vault key exists, or the exact block is in the report.
- [ ] The MCP server passes the Inspector CLI checks, and you saved the proof.
- [ ] M5 (OAuth for MCP) is complete, or its block is in the report.
- [ ] Telegram, chat, schedules, the daily brief, and approvals are complete, and their tests pass.
- [ ] The Health Center, the full diagnosis, and the setup checklist are live.
- [ ] S1 to S7 are complete with tests.
- [ ] Track Q is complete. Each fix has a test.
- [ ] P1 to P8 are complete, or each open item has a block reason.
- [ ] Track X and Track V are complete, or each open item has a reason.
- [ ] The STE standard and the STE check are in both repos.
- [ ] All suites pass. The numbers are in the report.
- [ ] The report, the BLOCKED ON SHREYAS list, and the Claude app handoff prompt exist.

## 12. Last reminder

Do not ask questions. Do not stop. Work through each track in order. If something blocks an item, record the block and go to the next item. Finish with the deliverables in Section 10.
