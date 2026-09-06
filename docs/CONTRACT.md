# Shared contract v1

The exact contract from the v2.0 build brief (`docs/RUNNER_V2_BRIEF.md`,
section 8), implemented as written. The private `shreyas-tech7/TITAN` repo
is being built to this same contract in a parallel run — this document is
the one both repos are meant to agree on.

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

Everything this repo publishes is public and must be redacted. This repo
never receives vault content and never asks for it. If a task needs
private context, it stops with `needs-human` and says what is missing
(`src/reviewer/`'s Layer 2 model verdict — see `docs/DECISIONS.md` D-4).

## How this repo implements it

`src/state/contract.js` is the validator; `scripts/verify-state.mjs` runs
it in CI against every `state/runs/*.json`. No zod/ajv — see
`docs/DECISIONS.md` D-2 for why a hand-rolled validator was used instead of
taking this repo's first runtime dependency.

`src/pulse.js`'s `writeRunRecord()` writes every contract field
**additively**, alongside every field this repo's dashboard already reads
(`state`, `tasks[]`, `files[]`, `markdownSummary`, `actionsRunUrl`, …) —
nothing was renamed or removed to make room for the contract:

| Contract field | This repo's source |
|---|---|
| `contractVersion` | `src/state/contract.js#CONTRACT_VERSION` ("1.0.0") |
| `runId` | The orchestration run's own UUID (`crypto.randomUUID()`) |
| `taskId` | `task.id` — `issue-<number>` for an issue-filed task, `manual-<timestamp>` for a `workflow_dispatch` one |
| `title` | `task.title` |
| `status` | Mapped from this repo's own task/run lifecycle — see below |
| `createdAt` / `updatedAt` | Both stamped at run-record write time (this repo does not yet track a separate in-flight `updatedAt` distinct from the final write) |
| `subtasks[]` | Mapped from the orchestrator's per-subtask records (`assignment.pool` -> `agent`/`provider`, `assignment.modelId` -> `model`, `attempts.length` -> `attempts`, summed `tokensUsed` -> `tokensOut`; `tokensIn` is not tracked separately anywhere upstream, always `null`; `costUsd` always `0`; `artifacts` are the synthesized files whose `sourceTaskId` matches) |
| `reviewer` | The Reviewer Gate's verdict for the *task* (not per-subtask — this repo's gate runs once per task, before decomposition) |
| `metrics` | `providerCalls`/`retries` summed across every subtask's attempts; `failoverHops` is approximated as `retries` (this repo does not currently distinguish "retried the same provider" from "failed over to the next one" at the metrics-aggregation level — both increment attempts) |
| `redacted` | Always `true` — every run record passes through `src/lib/secretScrub.js#scrubForState()` before it is written, and `scripts/check-secrets-in-state.mjs` re-scans everything under `state/` in CI as a second, independent check |

### Status mapping

This repo's own run-record field is `state` (`complete`/`failed`, unchanged
for backward compatibility with the dashboard), and its task-level field is
`status` (`pending`/`claimed`/`running`/`review`/`complete`/`failed`/
`blocked`/`cancelled`/`pr-open`). The contract's `status` enum is close but
not identical — this repo maps:

| This repo | Contract `status` |
|---|---|
| `pending` / `claimed` | `queued` |
| `running` | `running` |
| `review` (needs-human, parked) | `review` |
| `complete` | `done` |
| `failed` | `failed` |
| `blocked` | `blocked` |
| `cancelled` | `cancelled` |
| `pr-open` (self-improve, awaiting CI/merge) | no exact contract equivalent — reported as `running` in a run record until the PR resolves |

There is no `planning` state in this repo today — decomposition happens
synchronously inline within one `running` task, not as its own tracked
phase. A run record's `status` field is only ever written once, at the end
of `processTask()`, so `queued`/`planning` never actually appear in a
committed run record — they exist in the enum for the private TITAN repo's
own (different, longer-running) task lifecycle, and this repo's validator
still accepts them so a document that legitimately uses them elsewhere in
the shared ecosystem is not rejected.

### Provider ids

`groq | together | huggingface | openrouter | gemini | freebuff | opencode
| hermes` — this repo implements the first seven. `hermes` is named in the
contract as "optional" (task brief, Track B: "a documented failover ladder
across the five providers plus optional Hermes") and is not wired up in
this repo; a task carrying a `hermes` provider id in `state/runs/` (from
the private repo, if the two ever shared a store) would still validate
against `src/state/contract.js#PROVIDER_IDS`, which lists it, but this repo
never produces it itself.

## Failover ladder

Fixed, documented order (fastest/most-generous free tier first — see
`src/providers/registry.js#FAILOVER_ORDER`):

```
groq -> together -> openrouter -> gemini -> huggingface
```

`freebuff` has no public API to call at all (`src/agents/freebuffAgent.js`
— see `docs/RUNTIME.md`) and `opencode` is a separate agent pool
(`src/agents/opencodeAgent.js`), not part of this five-provider ladder; the
orchestrator's scheduler picks among all three pools (`freebuff`,
`opencode`, `phase2` — the wrapper around this exact five-provider ladder)
independently of provider-level failover. `hermes` is not implemented.

A provider is skipped, not retried into a failure, when either:
- `src/providers/health.js` reports it unhealthy (misconfigured, mid-cooldown after a real 429/402/5xx — this is the circuit breaker, cooldown persisted in `state/providers.json`), or
- `src/state/quota.js` reports it would exceed its known free-tier daily cap (`state/quota.json`, reset at UTC midnight).

Both checks are skipped for an explicit routing hint (a task's
`routingHint`, or the Reviewer Gate's own `service: 'groq'` call) — an
explicit choice still gets one honest attempt even mid-cooldown/at quota,
since it was a deliberate decision, not automatic failover.
