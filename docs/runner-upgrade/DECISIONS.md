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
