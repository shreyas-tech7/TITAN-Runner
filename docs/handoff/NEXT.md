# Steps that need a browser, an account, or a secret

This file is the running list for the Cowork handoff. Claude Code adds a step when it finds one. The final prompt in `docs/handoff/cowork-1.md` is built from this list. This file holds no secret value.

## Blocked now

1. **Push access for workflow files.** The `gh` token in the Codespace has the scopes `gist`, `read:org`, and `repo`. GitHub rejects any push that changes `.github/workflows/` without the `workflow` scope. The workflow commits wait on the local branch `claude/daily-assistant-wf` in the Codespace folder `/workspaces/TITAN-Runner-wf`. Fix: in the Codespace terminal, run `gh auth refresh -h github.com -s workflow`. Open https://github.com/login/device. Enter the one-time code. Approve for the account `shreyas-tech7` only.

## Repository settings (the repo rule forbids Claude Code from changing them)

2. Turn on Dependabot alerts at https://github.com/shreyas-tech7/TITAN-Runner/settings/security_analysis. They are off now (checked 2026-10-11).
3. Check that secret scanning and push protection are still on at the same page. They were on at the start of the run.
4. Optional: turn on "Validity checks" and "Non-provider patterns" at the same page. Both are free on a public repo.

## Rotation

5. No leaked key was found in the history or in Issues and pull requests (checked 2026-10-11). Nothing to rotate yet.

## To add as the run goes on

- Actions secrets and Worker secrets for the ops services: `OPS_TOKEN`, `DOORBELL_TOKEN`, `TITAN_BACKEND_URL`, host URLs, an optional Discord webhook.
- D1 migrations, if the deploy workflow cannot apply them.
