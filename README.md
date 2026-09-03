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

File a task through the dashboard or as a GitHub issue labeled `titan-task`.
Within 15 minutes, the next scheduled pulse (`.github/workflows/titan-pulse.yml`)
picks it up, decomposes it into subtasks, dispatches each subtask to a
free-tier model (Groq, Together, OpenRouter, Gemini, HuggingFace, plus
OpenCode's curated free catalog — see `docs/RUNTIME.md`; Freebuff has no
public API to dispatch to at all, also explained there), merges the
results, comments the outcome back on your issue, and closes it. A
provider-selftest workflow re-discovers each one's live model catalog and
checks it's actually reachable, weekly. Every pulse commits its state to
`state/*.json` — that's the whole database, since a GitHub Actions runner
is wiped clean after every run.

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
  (`src/denylist.js`) keeps it from ever touching `.github/workflows/`, the
  reviewer gate, the secret-handling code, or the denylist itself. See
  "Self-improvement" in `docs/RUNTIME.md`.

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

## Run it locally

```bash
npm install
npm run pulse:dry          # zero network calls, zero GitHub writes, fixtures only
TITAN_MANUAL_TASK="write a haiku generator" npm run pulse:dry
npm test                    # unit + integration tests, same zero-network guarantee
```

Copy `.env.example` to `.env` (or export the same variables) and unset
`TITAN_DRY_RUN` to hit real providers with real keys.

## Repository layout

```
src/            the pulse itself — orchestrator, provider adapters, reviewer gate, state I/O
state/          the database: tasks.json, agents.json, heartbeat.json, runs/, digests/, reviews/
dashboard/      static Next.js export published to GitHub Pages
scripts/        CI gate scripts (denylist, secret scan) and the weekly/dead-man's-switch jobs
test/           unit + integration tests (node:test), zero network required
.github/        the four workflows (pulse, CI, Pages deploy, keep-alive/dead-man's-switch)
docs/RUNTIME.md how the pulse works, minute-budget math, how to add a task, how to kill a runaway agent
```

## What this is not

Not a chat interface, not a place with a login, not always-on in the sense
of holding a live connection open — see `docs/RUNTIME.md`'s "Real-time is
gone" section for what static-dashboard polling actually gets you instead
of the SSE-based live view a hosted server could offer.

## License

MIT — see `LICENSE`.
