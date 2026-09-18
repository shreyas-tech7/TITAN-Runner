# Upgrade strategy

Written from the AS_FOUND map and the baseline harness numbers, and kept
current as the waves landed (the wave plan below is the one the task list
followed; PROGRESS.md records what each wave actually shipped).

## Runtime model

**A: GitHub Actions cron pulses.** One ephemeral job every 15 minutes, no
server, no card, the repository as the database. Everything the engine
adds must survive a job that can be killed at any instant and must never
assume two pulses cannot overlap. The half-built Cloudflare Worker queue is
out of scope (D-6).

## Principles

1. **Durability before cleverness.** A step boundary is the unit of
   progress; every boundary is a checkpoint; a killed job loses at most one
   step and never repeats a side effect.
2. **One place for each decision.** One transition table for status, one
   taxonomy for failures, one policy per failure class, one policy engine
   for side effects, one clock, one validated store. No string-matching at
   call sites.
3. **Free-tier quota is the scarce resource.** Count every call, skip a
   provider before it 429s, park instead of retrying into a wall, cap every
   loop.
4. **Honest states.** `waiting` is not `failed`; `unjudged` is not
   `verified`; `dead-lettered` says why. The issue comment says what the
   verifier found.
5. **Prove it.** A capability is declared only when a harness scenario can
   fail without it, and the harness fake sits under the real provider stack.

## Waves (each: green tests → commit → PROGRESS.md)

| Wave | Goal | Proof |
|---|---|---|
| 0 | Security first: intake authorization, `/titan` commands, self-improve write jail, SHA-pinned workflows, precise CI gates | security tests, workflow lint |
| 1 | Seams with zero behavior change; harness; `before.json` | baseline numbers |
| 2 | Durable foundation: validated versioned state + migration + repair, event log, lifecycle state machine, leases + reconciliation, checkpoints + resume, pulse budget, git checkpointer, idempotent side effects, dependencies, idempotency keys | crash / overlap / corrupt scenarios pass |
| 3 | Reliability: failure taxonomy, per-class retry policy, breakers, output repair, loop detection, parks, dead-letter, quota ledger, budgets | `fails-permanently` 15 → 4 calls, outage 48 → 9, no retry storm |
| 4 | Autonomy loop: tools (typed, jailed, SSRF-guarded), policy engine + autonomy levels + approvals, verification (checks + independent judge) + bounded remediation | `refusal`, `looping-task`, `tool-approval` scenarios |
| 5 | Control plane (workflow + CLI, audited), derived views, explain/replay, data contract files, dashboard lockstep | control tests, contract test |
| 6 | DX and docs: `titan` CLI, RUNTIME / CONFIG / DATA_CONTRACT / RUNBOOK, README | CLI tests |
| 7 | Adversarial tests (crash between every step pair, concurrency, chaos, security, contract, migration, memory ceiling), `after.json`, self-review, report, PR | `after.json`, REPORT.md |

## Explicitly not done, and why

- No new runtime (server, queue service, database): the brief's hard limit
  and the repo's own reason to exist.
- No new npm dependency: a public zero-maintenance repo cannot carry a
  supply chain; the validator, the YAML parser, and the CLI are hand-written
  and small.
- The dashboard is brought into lockstep with the data contract but not
  built in this run (no dependency install); its changes are checked by the
  contract test, not a compiler.
- No live smoke test: no provider key exists in this environment. The
  simulation and the harness are the evidence.
