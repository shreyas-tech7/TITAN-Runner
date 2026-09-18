# TITAN-Runner

A free, zero-maintenance GitHub Actions "pulse" runner for a multi-agent
orchestrator. No server, no credit card, nothing to keep running on your own
machine — a scheduled workflow wakes up every 15 minutes, checks a task
queue, dispatches work across free-tier AI providers, and commits the
result back to this repo.

**This repository is intentionally public.** GitHub Actions is free and
unlimited on public repos; a private repo gets a 2,000-minutes/month budget
that a 15-minute cron burns through almost immediately. Being public is
what makes "free forever" true — see the Security section below for what
that costs you.

Live dashboard: `https://<owner>.github.io/TITAN-Runner/` (once GitHub
Pages is enabled — see docs/RUNTIME.md).

## How it works, in one paragraph

File a task through the dashboard or as a GitHub issue labeled `titan-task`
(from an authorized author — see Security). Within 15 minutes, the next
scheduled pulse (`.github/workflows/titan-pulse.yml`) picks it up, plans
it into steps, runs each step on a free-tier model (Groq, Together,
OpenRouter, Gemini, HuggingFace, OpenCode's free catalog — see
`docs/RUNTIME.md`) with jailed tools when a step needs to read the repo,
classifies and retries or parks on every failure instead of storming a
provider, checkpoints after every step so a killed job resumes rather than
restarts, verifies the result with deterministic checks and an independent
judge model, and only then comments the outcome back on your issue and
closes it — or asks you first, depending on the autonomy level. Every
pulse commits its state to `state/` — that's the whole database, since a
GitHub Actions runner is wiped clean after every run. A weekly self-test
re-discovers each provider's live model catalog.

## Security — read this before filing a task

- Everything under `state/` and everything TITAN-Runner posts as an issue
  comment is **world-readable, forever**, cached and indexed by search
  engines regardless of a later edit or revert. Do not put a password, an
  API key, or anything private into a task.
- Every task and every model response is scanned and scrubbed
  (`src/lib/redact.js`, `scripts/check-secrets-in-state.mjs`) for
  credential-shaped strings and email addresses before it is ever written
  to `state/` or committed — but treat that as a backstop, not a reason to
  paste something sensitive on purpose.
- A Reviewer Gate (`src/reviewer/`) screens every task and every
  self-improvement proposal before it runs, and blocks anything that looks
  destructive (a recursive delete, a force push, a database drop, …) —
  see `docs/RUNTIME.md`'s "Reviewer Gate" section.
- The agent can propose changes to its own code, but only as a draft pull
  request — it can never push straight to `main`, and a fixed denylist
  (`src/denylist.js`) plus a path jail keep it from ever touching
  `.github/`, `package.json`, the reviewer gate, the secret-handling code,
  the policy engine, or the denylist itself. See "Self-improvement" in
  `docs/RUNTIME.md`.
- **Only authorized authors can file tasks**: the repository owner,
  GitHub-verified collaborators, and the logins in the `TITAN_TASK_AUTHORS`
  repository variable. Anyone else's `titan-task` issue is ignored and
  logged, never run. Bots are never trusted. `/titan …` control comments
  follow the same rule.
- **Autonomy is a dial, not a switch** (`docs/RUNBOOK.md`): `dry-run`
  (reads only), `propose` (asks before anything external), `approval`
  (asks before every write), `autonomous`. Set with the *TITAN Control*
  workflow; a kill switch, a drain, and a safe mode are one dispatch away.
  Every side effect the engine causes is decided by the policy engine and
  audited in `state/events/`.
- **Tools are jailed**: a step can read and search this checkout (never
  `.git/`, `node_modules/`, or a credential-shaped file), write only to its
  own scratch workspace, and fetch only https hosts on the operator's
  `TITAN_EGRESS_ALLOWLIST` (empty by default = nothing), resolved to public
  addresses only, with no redirects. It cannot run a shell.

## Give it a task

Three ways:

1. **The dashboard's "+ New task" button** opens an in-page form (title,
   description, priority, routing hint) and files it directly — no
   redirect to GitHub. Paste a fine-grained PAT into Settings once
   (scoped to this repo, Issues: Read and write) to file, cancel, and
   retry tasks from the dashboard itself; without one, the modal still
   validates your input and hands you the exact issue body to file
   yourself, with a pre-filled link.
2. **Open an issue** using the "TITAN task" template directly on GitHub.
   Add the `titan-self-improve` label if you want the result as a pull
   request against this repo instead of a one-off answer.
3. **Run it right now**, without waiting for the cron: Actions tab ->
   "TITAN Pulse" -> "Run workflow" -> fill in "Task text".

While it runs, comment on the issue (authorized users only): `/titan
cancel`, `/titan pause`, `/titan resume`, `/titan retry`, `/titan priority
urgent`, `/titan approve <key>` / `/titan deny <key>` when the runner asks.
The hidden YAML block also takes `dependsOn: issue-12`, `deadline:
<ISO 8601>`, and `ttlHours: 48`.

## Run it locally

```bash
npm install
npm run pulse:dry           # zero network calls, zero GitHub writes, fixtures only
node bin/titan.js simulate --pulses 3     # scripted fake provider + fake GitHub, no network
node bin/titan.js explain issue-1 --state /tmp/titan-sim-…   # why a task is where it is
node bin/titan.js doctor    # checkout, state files, schemas, keys
node bin/titan.js bench     # the benchmark harness (bench/results/)
npm test                    # 250+ tests, same zero-network guarantee
```

Copy `.env.example` to `.env` (or export the same variables) and unset
`TITAN_DRY_RUN` to hit real providers with real keys. Every knob is in
`docs/CONFIG.md`.

## Repository layout

```
src/engine/       the pulse engine: runPulse, orchestration, checkpoints, side-effect ledger, budget
src/task/         lifecycle state machine, leases, reconciliation
src/reliability/  failure taxonomy, retry policy, output repair, loop detection, quota ledger
src/tools/        the tool registry, built-in tools, SSRF guard
src/policy/       the policy engine (autonomy levels, approvals)
src/verify/       deterministic checks, the judge, verification
src/control/      /titan command grammar, control-plane dispatch and CLI
src/observability/ event log, derived views, explain/replay
src/state/        schemas, versioned validated store, migrations, paths
src/security/     intake authorization
src/fakes/        scripted fake provider and fake GitHub (simulation, harness, tests)
src/orchestrator/ decomposer, scheduler, router, synthesizer, capability registry
src/providers/    the five free-tier adapters, registry failover, health/breakers
src/reviewer/     the Reviewer Gate
bin/titan.js      the operator CLI
bench/            the benchmark harness, scenarios, results (before/after)
schemas/          the data contract (exported from src/state/schema.js)
state/            the database (see docs/DATA_CONTRACT.md)
dashboard/        static Next.js export published to GitHub Pages
scripts/          CI gates (denylist, secret scans, workflow lint, schema check), rollup, dead-man
worker/           the Cloudflare Worker sub-agent coordinator (unchanged, not deployed)
test/             unit, integration, crash, concurrency, security, contract tests (node:test)
.github/          workflows: pulse, control, CI, Pages deploy, keep-alive, dead-man, self-test, spawn-subagent, worker-deploy
docs/             RUNTIME.md (how it works), RUNBOOK.md (when it breaks), CONFIG.md (every knob),
                  DATA_CONTRACT.md (every file), runner-upgrade/ (the upgrade's own record)
```

**Always-on sub-agent cluster**: a second, additional layer — a Cloudflare
Worker ticking every minute, backed by D1, dispatching to GitHub Actions —
sits alongside the 15-minute pulse above without replacing it. Reuses the
same five provider adapters and the same Reviewer Gate; never bypasses
either. See docs/RUNTIME.md's "Always-on sub-agent cluster" section.

## What this is not

Not a chat interface, not a place with a login, not always-on in the sense
of holding a live connection open — see `docs/RUNTIME.md`'s "Real-time is
gone" section for what static-dashboard polling actually gets you instead
of the SSE-based live view a hosted server could offer.

## License

MIT — see `LICENSE`.
