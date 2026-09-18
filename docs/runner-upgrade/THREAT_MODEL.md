# TITAN Runner — threat model

Written before any security change. Everything here is public: the repo, every
commit, every state file, every workflow log, every issue and comment, and the
dashboard. A push is a publication.

## Assets

1. Provider API keys and the Worker admin token (GitHub encrypted secrets, Worker
   secrets). Loss = paid abuse of free-tier accounts, account bans.
2. The `GITHUB_TOKEN` of the pulse job (contents/issues/pull-requests: write on this
   repo). Loss = arbitrary commits to `main`, spam issues/PRs.
3. Free-tier quota (the scarcest runtime resource) and Actions runner time.
4. Integrity of `state/` (the queue and the record) and of the code on `main`.
5. The owner's private repo and vault — never reachable from here; must stay that way.

## Actors and trust

| Actor | Can do | Trusted for |
|---|---|---|
| Repo owner / collaborators with write access | open issues, add labels, comment, push branches, run workflows, merge | submitting tasks, control commands, approvals |
| Any GitHub user | open issues via the template (auto-applies `titan-task`), comment on any issue, open fork PRs, react | nothing |
| The models (Groq, Together, OpenRouter, Gemini, HF, OpenCode) | return arbitrary text | nothing — output is data |
| Web content fetched by a tool | arbitrary bytes | nothing |
| GitHub Actions platform | runs workflows, holds secrets | the platform boundary itself |
| Cloudflare Worker (if deployed) | holds a PAT with Secrets write | the admin token gate |

## Trust boundaries and the rules that follow

- **Task intake is attacker-controlled.** A label is not authorization. Only issues
  whose author is verified through the API (login in the allowlist, or
  `author_association` ∈ OWNER/MEMBER/COLLABORATOR) become tasks. Everything else is
  ignored at zero model calls and zero comments (commenting back would be a
  spam-amplification channel).
- **Comments are attacker-controlled.** Retry / cancel / pause / approve commands are
  honored only from authorized authors, only via an explicit `/titan …` command or the
  dashboard's marker comment, never from a bare `updated_at` bump.
- **Task text, tool output, model output are untrusted data.** They never change
  policy, autonomy, permissions, gate verdicts, or reach a secret. The policy engine
  reads only committed config and env; the models see labeled untrusted blocks.
- **The job that holds provider keys never executes model output.** Runner has no
  code-execution tool. Self-improve writes files and pushes a branch; tests on that
  branch run in CI on the PR with no provider secrets. File writes are jailed:
  no `.git/`, no `.github/`, no `package*.json`, no path traversal, no symlink escape.
- **Every side-effecting path goes through the reviewer gate and the policy engine**,
  enumerated in one place and covered by a test that fails when a new path bypasses it.
- **Secrets**: env → memory → redaction layer → any sink. One `redactString` pattern
  set, used by `scrubForState`, the event log, comments, and CI's state scan; a CI diff
  scan is added for code paths.
- **Network egress from tools**: allowlist of hosts, DNS resolution checked against
  private / loopback / link-local / metadata ranges before connecting, redirects
  re-checked, byte and time caps.
- **Workflows**: untrusted text reaches a step only through `env:` and is quoted;
  actions pinned to full commit SHAs; least-privilege permissions per job; concurrency
  groups; no `pull_request_target`; fork PRs get no secrets.
- **Self-modification**: PR only, denylist in code (tested) + CI backstop that hard-fails
  for the bot's own PRs and annotates human PRs.
- **No private storage exists.** A task that needs private content is "not supported
  here"; nothing fakes privacy.

## Attack scenarios considered

| # | Scenario | Result before | Result after |
|---|---|---|---|
| 1 | Stranger opens 50 template issues to burn quota / make the bot spam | 50 tasks run, 50 comments | ignored, 0 calls, one `intake.ignored` event with counts |
| 2 | Stranger comments "retry" on an owner's finished task | task re-runs | ignored; only an authorized `/titan retry` re-queues |
| 3 | Prompt-injected task text tells the model to write `.git/hooks/post-checkout` | file written, hook executed in the key-holding job | path rejected before any write; test proves it |
| 4 | Prompt-injected text asks to "disable the reviewer gate" / "set autonomy=full" | no mechanism existed (gate is code) | still no mechanism; policy reads config only; test proves task text cannot alter policy |
| 5 | A model returns a key-shaped string in its output | scrubbed from state; comment text scrubbed via redactString | same, plus event log scrub, plus CI diff scan |
| 6 | Tool asked to fetch `http://169.254.169.254/` or `http://localhost:…` | no tools existed | blocked by SSRF guard before DNS/connect |
| 7 | Overlapping pulses (dispatch + cron) claim the same task | concurrency group serializes; nothing else | leases + reconciliation make the second claimant skip |
| 8 | Killed pulse mid-task → re-run posts duplicate comments | duplicates | side-effect keys checkpointed; marker check before re-posting |
| 9 | Fork PR tries to read secrets via CI | CI has no secrets | unchanged |
| 10 | Bot's own self-improve PR touches `.github/workflows/` | refused in code, CI gate red | unchanged (hard fail), human PRs get an annotation instead of permanent red |
| 11 | Rate-limited provider retried into a failed pulse | cooldown skip existed | breaker + quota ledger + per-class retry policy |

## Residual risks (accepted, documented)

- The task prompt and the model's answer are public by design.
- The dashboard's admin token gates the Worker only; the page and `state/` are public.
- The Worker (if ever deployed) holds a PAT with Secrets write; its intake mirror gets
  the same author filter, but the Worker is denylisted for self-improve and cannot be
  deployed or verified from this run.
- Free-tier providers may ban an account for automated use regardless of anything here.
