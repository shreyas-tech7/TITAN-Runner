# Data contract

Everything the engine persists lives under `state/` as JSON (or JSON lines)
and is committed by the pulse. The shapes are defined once, in
`src/state/schema.js`, exported to `schemas/*.schema.json` by
`node scripts/export-schemas.mjs`, validated on every read and write by
`src/state/store.js`, and checked for drift by `test/contract.test.js` and
CI. The dashboard's `dashboard/lib/types.ts` mirrors them and the same test
holds its unions to the engine's lists.

| File | Schema | Version | Written by | Read by |
|---|---|---|---|---|
| `state/tasks.json` | `schemas/tasks.schema.json` | 2 | pulse, control CLI | pulse, dashboard, `titan explain` |
| `state/control.json` | `schemas/control.schema.json` | 1 | control workflow / CLI | pulse, dashboard |
| `state/heartbeat.json` | `schemas/heartbeat.schema.json` | 1 | pulse | dead-man workflow, dashboard |
| `state/checkpoints/<taskId>.json` | `schemas/checkpoint.schema.json` | 1 | pulse (every step boundary) | the next pulse that resumes the task |
| `state/events/<date>.jsonl` | `schemas/event.schema.json` (per line) | 1 | pulse, control CLI | views, `titan explain` / `replay`, analytics |
| `state/events/archive/<date>.json` | counts by type / outcome / failure class | 1 | event compaction (after 14 days) | analytics |
| `state/quota.json` | `schemas/quota.schema.json` | 1 | pulse | registry (before every call) |
| `state/leases/<taskId>.json` | `{ owner, acquiredAt, expiresAt }` | – | pulse (O_EXCL) | reconcile |
| `state/views/{queue,analytics,providers}.json` | see `src/observability/views.js` | 1 | pulse (end) | dashboard, operator; never the engine |
| `state/runs/<runId>.json` | run record (`src/engine/pulse.js#writeRunRecord`) | – | pulse | dashboard drawer |
| `state/providers.json`, `state/agents.json`, `state/pulse-history.json`, `state/reviews/`, `state/digests/` | unchanged from v1 | – | pulse, self-test, rollup | dashboard |
| `state/backup/<file>` | previous good copy of tasks.json / control.json | – | store (before each write) | store (repair) |
| `state/archive/tasks-<month>.jsonl` | archived terminal tasks | – | retention | nobody (history) |

## Versioning rules

- A file carries `version`. The store migrates forward on read
  (`migrateTasks`: v1 → v2 adds defaults, never deletes or renames a field,
  never changes a legacy status) and always writes the current version.
- Adding an optional field is not a version bump. Changing a field's
  meaning, removing one, or changing an enum is: bump `TASKS_SCHEMA_VERSION`,
  add a migration, extend `test/state-store.test.js`, run `npm run schemas`.
- Rolling back: `git revert` the state commit; v1 code ignores v2 fields.
- A file that fails validation is repaired from `state/backup/`, or replaced
  by the default with the bad bytes kept under `state/quarantine/`
  (git-ignored), and a `state.repaired` event is written.

## Task lifecycle (tasks.json v2)

Statuses: `pending → running → complete | failed | blocked | cancelled |
expired | dead-lettered | pr-open`, with `waiting` (reasons: `backoff`,
`dependency`, `approval`, `budget`, `quota`, `pulse-budget`, `provider`) and
`paused` as the non-terminal holds. The full transition table is
`TRANSITIONS` in `src/task/lifecycle.js`; `transition()` is the only writer
of `status` and appends a `task.transition` event and a bounded `history`
entry every time.

Key fields: `attempts`/`maxAttempts`, `lease`, `waitReason`/`wakeAt`,
`dependsOn`, `deadline`, `expiresAt`, `idempotencyKey` (duplicate
submissions never run twice), `failure` (`class`, `code`, `message`, `at`),
`parks`, `usage` (`calls`, `tokens`, `wallMs`, accumulated across pulses),
`autonomy` (per-task level, stricter of it and the control file wins),
`approvals` (`<key>: { decision, by, at }`).

## Events

One JSON object per line, redacted before it is written, `seq` continuous
within a day, `ts` ISO 8601, `pulseId` the writing pulse (or `control-…`).
Type names are dotted lowercase: `pulse.*`, `intake.*`, `claim.*`,
`task.transition`, `gate.verdict`, `plan.*`, `step.*`, `tool.call`,
`policy.decision`, `verify.*`, `remediate.started`, `run.*`,
`side-effect.*`, `routing.decision`, `control.*`, `reconcile.finished`,
`retention.*`, `state.*`. Events with `audit: true` are the audit log
(gate verdicts, policy decisions, control actions, side effects,
suppressions). Fields the schema names (`taskId`, `stepId`, `provider`,
`outcome`, `failureClass`, `calls`, `tokens`, `durationMs`) are stable;
other fields are per type and may grow.

## Checkpoints

`phase`: `planned → executing → executed → verifying → verified →
delivering`. `graph` (the plan, with `plannedBy`), `subtasks` (state,
attempts, output, error per step), `sideEffects` (key → time fired),
`tools` (non-idempotent tool calls already made), `verification` (verdict,
checks, judge, round), `remediations`, `usage`, `gate`. Deleted when the
task ends; retained through every wait.
