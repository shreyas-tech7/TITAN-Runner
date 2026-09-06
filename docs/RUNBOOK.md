# Runbook

Task brief, Track F. Companion to `docs/RUNTIME.md` (how the pulse works)
and `docs/CONTRACT.md` (the shared envelope shape) — this is the
task-oriented "how do I..." reference.

## Add a task

Three ways (unchanged from `docs/RUNTIME.md`'s "Task intake" section):

1. **Dashboard** — the "+ New task" modal. Files a `titan-task`-labeled
   issue with a structured `<!-- titan-task-v1 -->` YAML block.
2. **GitHub issue** — use the "TITAN task" template directly. Add
   `titan-self-improve` if you want the result as a pull request instead of
   a one-off answer.
3. **`workflow_dispatch`** — Actions tab -> "TITAN Pulse" -> "Run workflow"
   -> fill in "Task text". Runs immediately, no issue involved.

## Cancel a run

- **From the dashboard**: the task row's **Cancel** button closes the
  issue; the next pulse marks it `cancelled`.
- **From a comment**: post `/titan cancel` on the task's issue. Only the
  repo owner's own comments are honored (validated against the actual
  comment author, `src/github.js#repoOwnerLogin()` — never trusted from
  the label or body alone); it works even on a task that is currently
  `running`, not just one still queued.
- **Stop the whole pulse immediately**: Actions tab -> "TITAN Pulse" ->
  cancel the in-progress run. `concurrency: cancel-in-progress: false`
  means this never races a second pulse.
- **Stop it from ever running again**: Actions tab -> "TITAN Pulse" ->
  "..." -> "Disable workflow".

## Retry a blocked/failed/dead-lettered task

- **From the dashboard**: the task row's **Retry** button reopens the
  issue and posts a comment; the next pulse resets it to `pending`.
- **From a comment**: post `/titan retry` (repo owner only). Works on any
  terminal status, including a needs-human `review` task.
- **A dead-lettered (`titan-blocked`) task**: dead-lettering
  (`config.orchestrator.maxTaskAttempts`, default 3 — see
  `src/pulse.js#finalizeFailure()`) is a soft stop, not a hard one — add
  `titan-approved` and `/titan retry`, and the next pulse tries it again
  from scratch (its `failureCount` is not reset, so a further failure
  dead-letters it again immediately; fix the underlying cause first if
  it's obviously going to fail the same way).
- **A `needs-human` task (`titan-review` label)**: the Reviewer Gate parked
  it — read its comment for what it's missing, then add the
  `titan-approved` label. The next pulse resets it to `pending`
  (`src/issueSync.js#reconcileIssueState()`) — no separate retry needed.

## Rotate a provider API key

1. Generate a new key at the provider's own console.
2. Settings -> Secrets and variables -> Actions -> update the matching
   `*_API_KEY` repository secret (see the table in "Manual steps" below for
   exact names).
3. No workflow change needed — every workflow reads it via
   `${{ secrets.* }}` already. The next scheduled pulse (or a manual
   `workflow_dispatch` of `provider-selftest.yml`) picks it up.
4. If the OLD key is still valid and you want to confirm the new one
   actually works before the old one is revoked: run
   `.github/workflows/provider-selftest.yml` manually and check
   `state/providers.json` for that provider's `status`/`lastSuccessAt`.
5. A provider stuck at `status: "misconfigured"` (401/403 — this repo never
   auto-retries an auth failure) only clears on the next real *successful*
   call after the key is fixed — a self-test run or the next pulse that
   happens to route to it.

## Recover a stuck pulse

1. **Check `state/health.json`'s `beacon`** (or the dashboard's staleness
   banner) — amber past 20 minutes since the last successful pulse, red
   past 45.
2. **Check `state/lock.json`** — if `expiresAt` is in the past, the lock is
   stale and the *next* pulse will reclaim it automatically
   (`src/state/lock.js#acquireLock()`); nothing to do by hand. If it's not
   yet expired and you need to unblock immediately, delete the file and
   push directly to `main` — the next scheduled tick then acquires cleanly.
3. **Check the Actions tab** — a run still `in_progress` past its own
   10-minute `timeout-minutes` will be killed by GitHub itself; you don't
   need to cancel it manually, though you can.
4. **Check `.github/workflows/deadman.yml`'s alert issue** (labeled
   `titan-alert`) — it fires once, doesn't duplicate, and names what
   tripped (`scripts/check-heartbeat.mjs`'s output).
5. If the pulse is failing on every run: read the failed run's logs
   (Actions tab -> "TITAN Pulse" -> the failing run), fix the underlying
   bug, push to `main`. `state/heartbeat.json`'s `lastPulseError` also
   carries the (redacted) error message for the dashboard.

## Restore from archive

Pruned runs (past the 60-file cap on `state/runs/`) are compacted into
`state/archive/YYYY-MM.ndjson.gz` — the full JSON, one run per line,
gzipped — never just the human-readable digest line in
`state/digests/*.md`.

```js
import { readArchiveMonth } from './src/state/archive.js';
const records = readArchiveMonth('2026-03'); // -> full run record objects
```

Or from the shell:

```sh
node -e "console.log(JSON.stringify(await import('./src/state/archive.js').then(m => m.readArchiveMonth('2026-03')), null, 2))"
```

To bring a specific run back into `state/runs/` (e.g. to inspect it in the
dashboard's task detail drawer again): find it in the decompressed array by
`runId`, `JSON.stringify` it, and write it to
`state/runs/<runId>.json` by hand, then commit. There is no automated
"un-prune" script — restoring is rare enough that a one-off script isn't
worth maintaining.

## Manual steps (things only a human with repo admin can do)

These are **not** things this build could verify or complete itself — see
the final report's "Manual steps for me" section for the authoritative,
dated list. Kept here too since a runbook is where you'd look later:

- **Enable GitHub Pages**: Settings -> Pages -> Build and deployment ->
  Source: **GitHub Actions**. Until this is done, `pages-deploy.yml`'s
  `deploy` job fails with no useful logs (the signature of Pages never
  having been turned on) — this is a one-time, one-click setup step.
- **Add provider secrets** (all optional — a missing one just means that
  provider reports `not_configured`, never crashes anything): Settings ->
  Secrets and variables -> Actions -> New repository secret, using the
  exact names in `.env.example` (`GROQ_API_KEY`, `TOGETHER_API_KEY`,
  `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `HF_API_KEY`, plus the matching
  `*_MODEL` overrides if you want to pin a specific model).
- **Enable secret scanning push protection**: Settings -> Code security and
  analysis -> Secret scanning -> enable both "Secret scanning" and "Push
  protection". This is a GitHub-hosted feature toggle, not something a
  workflow file can turn on.
- **CodeQL and Dependabot** are both already configured as code in this PR
  (`.github/workflows/codeql.yml`, `.github/dependabot.yml`) — nothing
  further to enable manually beyond merging them; GitHub picks them up
  automatically once they land on the default branch.
- **The fine-grained PAT for the dashboard's task-filing/cancel/retry
  buttons** is a per-browser, per-person setup step (Settings panel in the
  dashboard itself) — scope: this repository only, **Issues: Read and
  write**, nothing else.
