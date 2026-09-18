# Decisions log (runner-upgrade)

The repo had no prior decisions log; numbering starts at D-1. Each entry: what was
decided and the one-line reason. Fork rule applied in order: security and private
data first, preserve working behavior, stay at $0, most capability for least
complexity.

- **D-1** Base the branch on `origin/main` `3396447`, not the open `runner-v2` PR
  branch — that branch has no merge base with current main; main carries the merged
  PRs #8–#12 and 118 pulses of real state.
- **D-2** Fix the open intake (any issue author) and the retry-by-any-comment hole in
  their own commits before feature work, because both burn quota and post comments on
  a stranger's say-so.
- **D-3** Authorization = GitHub-verified `author_association` (OWNER/MEMBER/
  COLLABORATOR) OR an explicit login allowlist `TITAN_TASK_AUTHORS` (default: the
  repository owner). Ignored issues get no comment and no model call; a comment back
  would be a spam channel.
- **D-4** Self-improve file writes get a jail (`.git/`, `.github/`, `package.json`,
  `package-lock.json`, absolute and traversal paths rejected before any write); the
  denylist itself gains `.git/` and `.github/` so the CI backstop matches.
- **D-5** The CI denylist gate hard-fails only for the bot's own PRs (head ref
  `self-improve/*` or author `github-actions[bot]`) and annotates human PRs — every
  human PR touching workflows was red and got merged anyway, which trains people to
  ignore red CI. The code-side denylist and the bot-side hard fail are unchanged.
- **D-6** Keep the pulse as the single source of truth; do not build on the Worker/D1
  queue. It is a second, uncoordinated queue for the same issues, is not deployed, is
  denylisted, and is live infrastructure this run may not touch. Only its intake
  mirror gets the same author filter (code-only change).
- **D-7** Add injection seams (state dir, clock, provider pools, GitHub client) with
  zero behavior change as the baseline commit, then measure "before" there, because the
  original entrypoint can only run against the real `state/` directory.
- **D-8** The benchmark fake sits *under* the real provider stack (a real
  `Phase2Agent` over a real `Registry` of `BaseProvider` subclasses) rather than
  replacing the pool, so both "before" and "after" measure the real retry,
  deadline, health, and failover code; only `_doChat` is scripted.
- **D-9** Durable checkpoints are git commits of `state/` pushed at step
  boundaries (`TITAN_CHECKPOINT=git`, rate-limited to one per 20 s, forced at
  pulse end), because git is the only storage that survives an Actions job. The
  workflow's own commit step stays as the final safety net; locally the state
  directory is the durable store and the checkpointer is a no-op.
- **D-10** Leases are O_EXCL lock files under `state/leases/` mirrored onto the
  task record: atomic on one machine, visible across machines once the checkpoint
  lands. The lease TTL (5 min default) is shorter than the cron gap so a dead
  pulse's task is reclaimable by the next one.
- **D-11** On a conflicting write the lease is the authority: a task this pulse
  leased keeps our version; a task someone else moved keeps theirs; our stale copy
  is dropped with a `state.merged` event. Same rule in the git re-apply path.
- **D-12** Corrupt state is repaired from `state/backup/<file>` (the previous good
  version, committed), never silently replaced with an empty default; the bad
  bytes go to `state/quarantine/` (git-ignored) with the parse error.
- **D-13** `tasks.json` gets retention: terminal tasks older than 30 days move to
  `state/archive/tasks-<month>.jsonl`; `state/events/` keeps 14 daily files and
  compacts older ones to count summaries. Idle pulses no longer rewrite unchanged
  files.
- **D-14** No new npm dependency for schema validation: a 120-line validator
  covering the JSON Schema keywords the state files need beats a multi-MB
  dependency on a zero-maintenance public repo.
- **D-15** One retry authority. The provider base no longer retries HTTP
  statuses (429/5xx) inline, only a statusless network fault, once; the registry
  fails over across at most three providers for an `auto` call and not at all for
  a named one. Three stacked retry layers were the 15-call storm the baseline
  measured for one doomed step.
- **D-16** A provider-side fault (outage, rate limit, quota) parks the task as
  `waiting(provider | quota)` with a wake time on a 5 m → 3 h ladder rather than
  failing it; our own faults (permanent, poisoned, policy) never wait. A task
  that parks more than `TITAN_MAX_PARKS` times is dead-lettered with one note.
- **D-17** Budgets are ceilings, not targets: per task (calls, tokens, active
  wall time, accumulated in the checkpoint) and per pulse (calls). Exceeding a
  task ceiling is a `budget_exhausted` dead-letter; hitting the pulse ceiling
  drains to `waiting(pulse-budget)` and stops claiming.
- **D-18** The quota ledger is a scheduling input with conservative documented
  defaults, not a guarantee; a real 429 still opens the breaker. Limits are
  overridable per provider through the environment.
- **D-19** A planning call that fails on the provider side parks the task; it is
  not degraded to a single-step plan (the old fallback stays for parse failures).
- **D-20** The engine clock (`lib/clock.js`) can be offset only while the fakes
  are wired, so the harness can simulate the cron gap and a production pulse can
  never be moved off the wall clock by an environment variable.
- **D-21** The policy engine sits beside the Reviewer Gate, never instead of
  it: the gate still decides whether a task may run at all (unchanged); the
  engine decides, per side effect, whether the autonomy level lets it happen,
  needs `/titan approve <key>`, or forbids it. Tool calls additionally pass the
  gate's deterministic layer (a destructive pattern is refused outright).
- **D-22** Four autonomy levels (dry-run, propose, approval, autonomous), the
  effective level being the stricter of the control file and the task. An
  approval request is the one external effect allowed under propose/approval
  (otherwise nobody could ever approve); dry-run and safe mode suppress every
  comment, and the suppression is audited.
- **D-23** Tools are typed (schema-validated arguments), classed by side
  effect, jailed (reads: the checkout minus `.git/`, `node_modules/`, and
  credential-shaped names; writes: the task's own workspace under `state/`,
  never the checkout), and network-guarded (https only, operator allowlist,
  DNS-resolved public addresses only, no redirects). A model can never invent
  a tool, an argument, or a path the registry did not declare.
- **D-24** One tool call per model turn, re-prompted with the result; the
  same call three times, or more than six calls in a step, is a loop and the
  step is poisoned. A tool that needs approval parks the whole task on
  `waiting(approval)` rather than failing the step.
- **D-25** Verification is two layers: free deterministic checks first (a
  failure there never costs a judge call), then a judge model chosen from the
  providers that produced no part of the run, plan included. "Unjudged" is an
  honest recorded state (no independent provider left, judge down), not a
  silent pass; `TITAN_VERIFY_STRICT=1` turns it into a failure.
- **D-26** Remediation is bounded (`TITAN_MAX_REMEDIATIONS`, default 1) and
  targeted: only the steps the verdict names, plus everything downstream, run
  again, with the feedback in their prompt. A run that still fails is failed
  with the reason on the issue, never quietly marked complete.
- **D-27** A resolved file conflict (both versions kept by the synthesizer) is
  a verification warning the judge sees, not a failure; the offline dry-run
  fixture produces one on purpose.
- **D-28** The bench corpus's `spans-pulses` script now answers its
  code-generation steps with a small file instead of prose: the old prose was
  a placeholder from before verification existed, and the verifier is right
  to reject a code step that produced no code. Every other scenario is
  unchanged from `before.json`.
- **D-29** The control plane is a `workflow_dispatch` workflow plus a CLI, and
  nothing else: GitHub authenticates the dispatcher (write access) and names
  them (`github.actor`), the CLI applies one validated action and appends one
  audited event, the workflow commits `state/`. Inputs reach the script only
  through the environment. No control action is ever read from an issue or a
  comment (those are the task-scoped `/titan` commands, already authorized by
  author association).
- **D-30** Views under `state/views/` are derived, never read back by the
  engine: a stale or missing view cannot change a decision, so the dashboard
  and the operator can rely on them without the engine depending on them.
- **D-31** The data contract is a set of plain schema files (`schemas/`)
  exported from the one in-code definition, with a test that fails when they
  drift, and text-level lockstep tests for the dashboard's unions and YAML
  fields. The dashboard itself is not built in this run (no dependency
  install), so its TypeScript changes are checked by inspection and by those
  tests, not by a compiler — stated as such in the report.
- **D-32** Crash recovery is proven with a real SIGKILL of a real pulse
  process at every step boundary, not with an in-process exception: an
  event-log subscriber's throw is swallowed by design, and only a dead
  process proves "nothing in memory survived".
- **D-33** `/titan` arguments are exactly as many plain bounded tokens as
  the verb takes; a comment with trailing text, shell characters, or an
  over-long key is not a command at all (it used to be truncated and
  accepted).
- **D-34** A derived view is rewritten only when something other than its
  timestamp changed; an idle pulse must not churn files for a clock tick.
- **D-35** A filer may set `autonomy` in the task YAML, but the engine runs
  at the stricter of the task's level and the control file's, so the field
  can only ever ask for less autonomy. Every other engine-internal field in
  the block is ignored.
