# TITAN-Runner v2.0 BUILD BRIEF — public repo (shreyas-tech7/TITAN-Runner)

You are the sole engineer on this run. Execute this entire brief in one unattended pass.

## 0. OPERATING RULES

1. **Do not ask me any questions.** Not at the start, not mid-run, not at the end. No clarification requests, no "should I proceed", no option menus. If something is ambiguous, choose the option that best preserves existing behavior, record it in `docs/DECISIONS.md` as a new D-number, and keep moving.
2. **Do not pause for approval between phases.** Run every track to completion.
3. **Report honestly.** A workflow that has never actually run on GitHub is unverified, and you must label it that way. Never claim a green run you did not observe. Never invent test counts or timings.
4. **Everything is additive.** The existing pulse must keep working through the whole change.
5. **This repo is PUBLIC.** Assume every byte you commit is read by strangers forever. No vault content, no personal data, no file paths from my machine, no secrets, not even in a test fixture or a comment.
6. **Cost is strictly $0.** No paid tiers, no credit card, no service that requires one. Only free-tier providers and GitHub Actions minutes.
7. **First commit of this run:** save this brief verbatim to `docs/RUNNER_V2_BRIEF.md`.

## 1. PHASE 0 — GROUND TRUTH BEFORE YOU BUILD

Verify, do not assume. Record what you actually find in the final report.

- Repo layout, existing workflows, cron schedule, and whether recent pulse runs succeeded or failed. Read the real Actions history.
- The five provider adapters (Groq, Together, HuggingFace, OpenRouter, Gemini) and the ported reviewer/safety gate: confirm they exist and what shape they are in.
- The current committed state under `state/`, its shape, and its total size on disk. Measure repo size.
- The GitHub Pages dashboard at `shreyas-tech7.github.io/TITAN-Runner`: what it renders today and where it reads from.
- The task intake path: GitHub Issues labeled `titan-task`. Confirm how the pulse picks them up.
- Which repository secrets exist by name only. Never echo a value.

Then cut branch `claude/runner-v2`.

## 2. TRACK A — PUBLIC-REPO SAFETY (do this first)

1. **Redaction gate.** Nothing gets committed to `state/` without passing a redaction pass: strip absolute paths, usernames, emails, tokens, IPs, and any field not in the contract allowlist. Set `redacted: true` only when the pass ran. Fail the job if the gate is skipped.
2. **Shell injection through issue content.** Issue titles and bodies are attacker-controlled text flowing into workflows. Never interpolate `${{ github.event.issue.title }}` or any issue field directly into a `run:` block. Pass through `env:` and quote. Audit every existing workflow for this and fix it. Add a test using a hostile title.
3. **Prompt injection.** Issue content reaching a model is untrusted data, never instructions. Wrap it, label it, and add hostile fixtures to the test suite.
4. **Workflow permissions.** Least privilege at job level, `contents: write` only where the job actually commits, no `pull_request_target` on untrusted input, `persist-credentials: false` where credentials are not needed.
5. **Pin every action to a full commit SHA** with the version in a trailing comment. Add `timeout-minutes` to every job.
6. **Scanning:** gitleaks in CI, CodeQL enabled, Dependabot configured. Document enabling secret scanning push protection in the runbook.
7. **History check.** Scan the full git history for anything that should never have been public. If you find something, do not rewrite history on your own. Report it under manual steps with the exact locations.

## 3. TRACK B — PULSE RELIABILITY

- **Idempotency and locking.** A single lock in `state/lock.json` carrying run id, holder, and expiry. Overlapping pulses no-op instead of double-running. Stale locks reclaim after a timeout. Add a workflow `concurrency` group.
- **Resumability.** Checkpoint at the subtask level. A pulse that hits the job time limit resumes on the next tick instead of restarting the task.
- **Retries and failover.** Exponential backoff with jitter per provider call, a per-provider circuit breaker with cooldown persisted in state, and a documented failover ladder across the five providers plus optional Hermes.
- **Quota ledger.** `state/quota.json` tracks per-provider daily usage against known free-tier limits, resets at UTC midnight, and skips exhausted providers instead of burning retries on them.
- **Dead letter.** After a capped number of attempts, label the issue `titan-blocked`, comment the reason and the run id, and stop retrying.
- **Heartbeat.** Every pulse writes `state/health.json` with last run time, duration, outcome, and provider status. The dashboard turns amber then red when the beacon goes stale.
- **Job summaries.** Write a readable run summary to `$GITHUB_STEP_SUMMARY` on every pulse, success or failure.

## 4. TRACK C — STATE STORE

- Versioned schema with a `contractVersion` field, validated on read and write with zod or ajv. Reject unknown majors loudly.
- Atomic writes and conflict-free commits. Never let two pulses stomp each other's state.
- **Compaction.** Keep the most recent N runs hot in `state/runs/`, roll older ones into `state/archive/YYYY-MM.ndjson` (gzipped), and keep `state/index.json` small and cheap to fetch.
- **Size budget.** The repo stays lean. Warn in CI above 50 MB, fail above 100 MB. Report current size before and after.
- A `prune` and a `verify` script, both runnable locally and in CI.

## 5. TRACK D — TASK PROTOCOL OVER ISSUES

- Structured task envelope in the issue body as a fenced YAML block, with an issue form template so tasks are well formed by default.
- Label lifecycle: `titan-task` to `titan-running` to `titan-review` to `titan-done`, with `titan-blocked` and `titan-cancelled` as terminals. The pulse owns the transitions.
- Human approval gate: anything the reviewer marks `needs-human` waits for a `titan-approved` label before it proceeds. Nothing destructive runs without it.
- Comment commands: `/titan cancel`, `/titan retry`, `/titan status`. Restrict them to the repo owner and validate the actor before acting.
- Progress reporting: one rolling comment per task, edited in place instead of spamming a new comment per step.

## 6. TRACK E — PAGES DASHBOARD

Static only, no build server, no keys in the client, everything read from committed JSON over relative paths.

- **Live world map** showing provider endpoints and regions, health color coded, with request flow on recent runs.
- **Run timeline** for each task: subtasks, provider used, attempts, durations, reviewer verdict.
- **Per-agent thread view**, read only, so a conversation with an agent is legible after the fact.
- **Health beacon** driven by `state/health.json`, with a plain-English last-pulse line.
- **Mobile first.** It has to be genuinely usable on a phone. Add a PWA manifest and an offline cache of the last known state.
- Theme parity with the private HUD: cyan on gunmetal. Real motion with easing, `prefers-reduced-motion` honored.
- Accessible: keyboard reachable, visible focus, labeled controls, contrast checked.
- Graceful empty and error states. A missing or malformed state file shows a clear message, not a blank page.

## 7. TRACK F — TESTS, CI, DOCS

- Unit tests for the orchestrator, adapters, reviewer gate, redaction gate, schema validation, and quota ledger.
- A `PULSE_DRY_RUN=1` mode that exercises the full pulse against fixtures with zero network calls. CI runs this on every PR.
- `actionlint` on every workflow file in CI.
- Coverage gate that fails on a drop from the new baseline.
- Docs: `README.md` with the architecture and a status badge, `docs/CONTRACT.md`, `docs/RUNBOOK.md` (add a task, cancel a run, rotate a key, recover a stuck pulse, restore from archive), `docs/DECISIONS.md` continuing from the highest existing D-number.

## 8. SHARED CONTRACT v1 WITH THE PRIVATE TITAN REPO

The private repo `shreyas-tech7/TITAN` is being built to this same contract in a parallel run. Implement it exactly as written. Put it in `docs/CONTRACT.md`.

```
contractVersion: "1.0.0"

Run envelope:
  runId          string, uuid
  taskId         string, GitHub issue number when the task came from the runner
  title          string
  status         queued | planning | running | review | blocked | done | failed | cancelled
  createdAt      ISO 8601 UTC
  updatedAt      ISO 8601 UTC
  subtasks[]     { id, title, agent, provider, model, status, startedAt, endedAt,
                   attempts, tokensIn, tokensOut, costUsd (always 0), artifacts[] }
  reviewer       { verdict: allow | block | needs-human, reasons[], ruleIds[] }
  metrics        { durationMs, providerCalls, retries, failoverHops }
  redacted       boolean, must be true for every envelope in this repo

Provider ids: groq | together | huggingface | openrouter | gemini | freebuff | opencode | hermes
```

Everything this repo publishes is public and must be redacted. This repo never receives vault content and never asks for it. If a task needs private context, it stops with `needs-human` and says what is missing.

## 9. VERIFICATION GATE (before the final commit)

1. Full test suite, once, sequentially. Record real pass, fail, and skip counts.
2. Dry-run pulse end to end against fixtures, green.
3. `actionlint` clean on every workflow.
4. One real pulse triggered through `workflow_dispatch`. Read the actual logs. If it fails, fix it and run again. Report the real run URL and outcome.
5. Pages dashboard loads and renders from live committed state, checked at both desktop and phone widths, no console errors.
6. Grep the diff and the whole tree for secrets, personal paths, and vault content. Confirm zero.
7. Confirm repo size against the budget.

## 10. COMMIT AND PUSH

- Logical commits, one concern each, conventional commit messages.
- Push `claude/runner-v2` and open a PR listing what shipped, what is verified, what is not, and the manual steps left.
- Merge to `main` once the gate passes and Pages redeploys clean. Tag `v2.0`. No force-push, no rewritten history.

## 11. FINAL REPORT FORMAT

End with exactly these sections and nothing else:

1. **Shipped** — built and verified, one line each.
2. **Built but not verified** — exists in code, never proven, and why.
3. **Not done** — skipped and why.
4. **Real numbers** — test counts, coverage, repo size before and after, real pulse run outcome with the run URL.
5. **New decisions** — the D-numbers you added.
6. **Manual steps for me** — secrets to add by name, settings to toggle, anything needing my hands.
7. **Risks** — what is most likely to break next.

Begin now. Do not ask questions. Do not wait for confirmation.
