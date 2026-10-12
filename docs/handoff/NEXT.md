# Steps that need a browser, an account, or a secret

This file lists the steps for the Cowork handoff. Claude Code adds a step when it finds one. The file `docs/handoff/cowork-1.md` comes from this list. This file holds no secret value.

## Blocked now

1. **Push access for workflow files.** Cowork handoff 1 reported that the `workflow` scope was added. Claude Code checked on 2026-10-12 at 03:17 UTC. The stored login in the Codespace `jubilant-space-waffle-96w7gpxrj76937xgw` still lists only `gist`, `read:org`, and `repo`, and a push was refused. Cowork probably used another Codespace. Fix: open that exact Codespace and run `env -u GITHUB_TOKEN -u GH_TOKEN gh auth refresh -h github.com -s workflow`. Open https://github.com/login/device. Enter the one-time code. Approve for the account `shreyas-tech7` only. Then run `env -u GITHUB_TOKEN -u GH_TOKEN gh auth status` and look for `workflow`. The workflow commits wait on the local branch `claude/daily-assistant-wf` in `/workspaces/TITAN-Runner-wf`. See `docs/handoff/cowork-2.md`.

## Repository settings (the repo rule forbids Claude Code from changing them)

2. Turn on Dependabot alerts at https://github.com/shreyas-tech7/TITAN-Runner/settings/security_analysis. They are off now (checked 2026-10-12).
3. Secret scanning and push protection are on (checked 2026-10-12). Leave them on.
4. Optional: turn on "Validity checks" and "Non-provider patterns" at the same page. Both are free on a public repo.

## Secrets and addresses

5. **`OPS_TOKEN`.** One random secret of 32 characters or more. Shreyas makes it. He pastes it in three places. The first is the Actions secret `OPS_TOKEN`. The second is the Worker secret `OPS_TOKEN` (Cloudflare, Workers & Pages, `titan-runner-brain`, Settings, Variables and Secrets). The third is the environment of TITAN. Until he sets it, every `/ops` route answers 401.
6. **Doorbell.** Two Actions secrets. `DOORBELL_TOKEN` has the same value as in the environment of TITAN. `TITAN_BACKEND_URL` is the public address of the TITAN backend. Without them, `doorbell.yml` skips every run.
7. **Host addresses (optional).** Actions secrets `HOST_URL_HF_SPACE`, `HOST_URL_RENDER_1` to `3`, and `HOST_URL_HERMES_1` to `3`. The probe skips a host with no address. The repository variable `GEV_URL` already names the God's Eye View host.
8. **Discord (optional).** The Actions secret `DISCORD_WEBHOOK_URL` sends a short message when a host alert opens or closes.
9. The Actions secret `GROK_API_KEY` is not used by any provider in the catalog. Shreyas can delete it, or add a provider for it.

## Dependabot (checked 2026-10-12)

11. Pull requests 34 and 35 are the same change. Their branches have no difference. Both lift `wrangler` in `/worker` to 4.149.0, with `sharp` 0.35.5 and `undici` 7.29.1. The Worker tests (303 of 303) and a dry run of the deploy pass. Merge one and close the other.
12. Pull request 36 lifts `next` in `/dashboard` from 15.5.24 to 15.5.27. The type check, 118 tests, the build, and 15 browser tests pass. It is safe to merge.
13. The alerts for `postcss` and `source-map-js` stay open, because `next` ships its own `postcss` 8.4.31. They affect the build, not the live site. They close when `next` ships a fix.

## Rotation

10. The full history scan found no real key (1102 commits, 2026-10-12). Issues and pull requests have none either. Nothing to rotate.

## After the push scope is fixed (Claude Code does these)

- Push `claude/daily-assistant-wf`, open a new pull request, merge it with a merge commit.
- Run each new workflow once with `workflow_dispatch` and check the output: gitleaks, state maintenance, provider canary, golden task eval, host status, doorbell.
- Check that the Ops page shows live data. Check that the files under `state/ops/` have data.
