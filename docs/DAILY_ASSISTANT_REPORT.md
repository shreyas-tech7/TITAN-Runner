# Daily assistant run: completion report

Date: 2026-10-12. Repository: https://github.com/shreyas-tech7/TITAN-Runner. The record of every item is in `docs/DAILY_ASSISTANT_PROGRESS.md`.

## What shipped

Everything is merged into `main` and runs on GitHub. Nothing waits on a branch.

**Trust gaps**

- Secret scanning: `.gitleaks.toml`, a pre-commit hook, a scan of Issue and pull request text, and a `Secret scan` workflow. It scanned 1151 commits on GitHub and found no leak.
- Hardened workflows and Issues: owner-only intake, least-privilege permissions, one shared group for every workflow that commits to `state/`, and one publish script with rebase and retry.
- The Reviewer Gate covers every GitHub write and every VM command. A static test fails if any other file does a GitHub write.
- Tool arguments: every bad field is named.
- Worker auth: expiring sessions, a sign-in limit with backoff, a sign-in log, CORS locked to the Pages origin, and input limits.
- VM fleet: no long-lived provider key goes to a VM.
- State hygiene: a strict schema for every state file, monthly archives, and a daily maintenance run.

**Shared ops services (contract v1)**

- Quota meter and routing rules, with the source and date of each limit.
- Nightly provider canary.
- Weekly golden task eval, and measured scores in the router.
- Post-mortems and lessons for the planner.
- Host status and alerts.
- Doorbell for TITAN.

**Dashboard.** A new Ops tab: provider health, quota meter, eval scores, host status with uptime bars, lessons, and a Security panel after the sign-in. The sign-in uses an expiring session and the page keeps no admin token.

## Test counts

| Suite | Before | After |
|---|---|---|
| Root tests | 405 | 673 |
| Worker tests | 235 | 303 |
| Dashboard tests | 93 | 118 |
| Browser tests | not counted | 83 (15 new) |

`node scripts/check-all.mjs` passes. actionlint 1.7.7 with shellcheck reports nothing for any workflow that this run added or changed.

## Live checks (2026-10-12)

- The Pages site serves https://shreyas-tech7.github.io/TITAN-Runner/ops/ with all six panels. The page does not scroll sideways at 390 pixels.
- The Worker https://titan-runner-brain.titan-runner.workers.dev runs the merged code (schema version 6). Every `/ops` route answers 401 without a token. A wrong token on `/auth/login` answers 401. Another origin gets 403.
- The four mirrors `state/ops/health.json`, `quota.json`, `eval.json`, and `hosts.json` exist on `main`.
- Each new workflow ran once by hand on GitHub and passed. The pulse ran with the hardened workflow and wrote valid state.
- The host alert flow ran live. Issue 32 opened after two failed checks, a third failure reused it, and a good check closed it.

## What the run found by testing

These were real bugs, and they are fixed.

1. A first sign-in on a fresh database answered 500, because a public route used D1 before the migrations ran. A test in the real runtime guards it.
2. Seven workflows would not parse as YAML, because a commit message in a `run:` line held a colon and a space. actionlint found it. The workflow linter has a rule for it now.
3. Groq model discovery chose a text to speech model (`canopylabs/orpheus-v1-english`). Every Groq call failed with a 400 since 2026-10-11. The nightly canary found it on its first run.
4. Groq retired its default model `llama-3.3-70b-versatile`. The default is now `openai/gpt-oss-20b`.
5. The canary token budget was too small for a reasoning model. It is 512 tokens now.
6. The canary called a 403 about a model an `auth` problem. It is `model_invalid` now.
7. The browser test stack did not know the CORS lock. A stale tab test and a racy row count are fixed too.

The last canary run shows Groq, OpenRouter, and Gemini healthy.

## Decisions

- Two kinds of pull request. The code went first because it passes alone. The workflow files went second, after the push scope was fixed.
- Gitleaks hits that were fake test values got exact-value entries in the allowlist. History was not rewritten.
- Dependabot pull requests 34 and 36 were tested in scratch worktrees and then merged. Pull request 35 was identical to 34. Overrides for the packages that `next` pins are in pull request 47.
- Unknown stays unknown. A limit that no official page states is `null`, and the meter says "limit unknown". The eval leaves out a category that ran no task.

## Blocked, with the reason and the fix

| What | Why | Fix |
|---|---|---|
| The workflows do not post to the Worker. The `/ops` routes hold no data. | `OPS_TOKEN` is not set. | Shreyas sets `OPS_TOKEN` in the Actions secrets, the Worker secrets, and the environment of TITAN. See `docs/handoff/NEXT.md`. |
| The doorbell skips every run. | `TITAN_BACKEND_URL` and `DOORBELL_TOKEN` are not set. | Shreyas sets both Actions secrets. |
| Render and Hermes hosts have no uptime. | Their addresses are not set. | Optional. Shreyas sets `HOST_URL_*`. |
| The lock screen check of the live page. | The Cowork browser holds a saved admin token. | Shreyas opens the Ops page in a private window. |

When the secrets are set, a Claude Code session follows `docs/handoff/after-secrets.md` and closes the last items.

## Open points that are not blockers

- The free models of OpenRouter change often. Pin one with the Actions secret `OPENROUTER_MODEL`. The eval gave `nvidia/nemotron-3.5-lightning:free` 0.86 over 14 tasks.
- Pull request 22 (your draft that bumps the pinned actions) changes the same lines as the hardened workflows. It may need a rebase.
- The `GROK_API_KEY` secret is not used by any provider in the catalog.
