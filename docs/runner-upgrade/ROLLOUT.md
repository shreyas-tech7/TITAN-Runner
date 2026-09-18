# Rollout notes

Nothing in this branch changes a repository setting, a secret, or a live
system. Merging it changes what the next pulse does. In order:

1. **Merge the PR** (a human decision; nothing merges itself). The first
   pulse after merge migrates `state/tasks.json` from v1 to v2 on read and
   writes v2 (the v1 copy goes to `state/backup/`). `git revert` of the state
   commit rolls it back; v1 code ignores v2 fields.
2. **Start conservative**: Actions → *TITAN Control* → Run workflow →
   `autonomy` / `propose`. The runner plans, runs, verifies, and then asks
   on the issue before posting or opening a PR. Move to `autonomous` when
   the first few results look right. `kill-switch on` stops everything at
   any time.
3. **Repository variables** (Settings → Secrets and variables → Actions →
   Variables): `TITAN_TASK_AUTHORS` (extra logins allowed to file tasks;
   empty by default), `TITAN_EGRESS_ALLOWLIST` (hosts `http_fetch` may
   reach; empty by default = none).
4. **Secrets** are unchanged: the same provider keys as before. Run
   *Provider self-test* after setting them.
5. **Dashboard**: `cd dashboard && npm install && npm run build` locally
   before relying on the Pages deploy; this branch changed its types and
   three components without a compiler run.
6. **Watch**: `node bin/titan.js doctor`, `state/views/queue.json`,
   `state/views/analytics.json`, and `titan explain <taskId>` for anything
   that waits. The dead-man workflow is unchanged.
7. **Rollback** at any point: revert the merge commit. State files written by
   v2 are readable by v1 (extra fields ignored); checkpoints and leases are
   simply unused.

What changes for a filer: nothing required. Optional YAML fields
(`dependsOn`, `deadline`, `ttlHours`, `autonomy`) and `/titan` comments are
available; tasks from unauthorized authors are ignored (they were run
before — that was the security hole).
