# After the secrets: the last checks of the daily assistant run

This is a runbook for a Claude Code session. Shreyas starts it with a prompt such as "Continue the TITAN-Runner daily assistant run. The secrets are set." Do not ask questions. Do not stop without a result.

## What is done

Everything ships and runs on GitHub. The workflows are on `main`, and each one ran once by hand. The one thing that is still open is the secrets. Without them, the Worker cannot take results from the workflows, and the doorbell cannot ring. `docs/DAILY_ASSISTANT_PROGRESS.md` has the full record.

## What Shreyas sets (names only, never values)

| Name | Where | Effect |
|---|---|---|
| `OPS_TOKEN` | Actions secret, Worker secret, and the environment of TITAN. The same value in all three. | The workflows post to the `/ops` routes. TITAN can read them. |
| `DOORBELL_TOKEN`, `TITAN_BACKEND_URL` | Actions secrets. The token is also in the environment of TITAN. | `doorbell.yml` rings TITAN. |
| `HOST_URL_HF_SPACE`, `HOST_URL_RENDER_1` to `3`, `HOST_URL_HERMES_1` to `3` | Actions secrets (optional) | `ops-hosts.yml` checks those hosts. |
| `DISCORD_WEBHOOK_URL` | Actions secret (optional) | A short message when a host alert opens or closes. |

## Checks, in this order

1. **The names exist.** Run `env -u GITHUB_TOKEN -u GH_TOKEN gh secret list`. Look for the names above. Never print a value.
2. **The ops token matches.** Run the workflow Provider canary by hand (`gh workflow run "Provider canary" --ref main`). In its log, the line `ops-canary: POST /ops/health answered 200` means that the Actions secret and the Worker secret are the same. A 401 means that they differ, or that the Worker secret is not set yet. In that case, tell Shreyas which one to set again.
3. **The other posts work.** Run Host status and Golden task eval by hand. Look for `POST /ops/hosts answered 200` and for the eval post. Host status also writes `state/ops/quota.json` from `GET /ops/quota`, so a quota file with providers in it proves that the read route works too.
4. **The doorbell rings.** Run Doorbell by hand with the job `sweep`. The log must say `sweep -> 200` or the status code that TITAN answers. A 401 means that `DOORBELL_TOKEN` differs from the value in TITAN. A `no connection` means that `TITAN_BACKEND_URL` is wrong or the host sleeps. Never print the address. Run the other two jobs once as well.
5. **The usage ledger fills.** After the canary and the eval ran, `state/ops/quota.json` shows the used counts for the providers that were called.
6. **The mirrors are valid.** `node scripts/check-state.mjs` must pass on the latest `main`.
7. **A host alert still works.** If `HOST_URL_*` secrets exist, check that no `host-alert` Issue is open without a reason. Close nothing by hand. The workflow closes an alert when the host is back.
8. **The Ops page shows live data.** Open https://shreyas-tech7.github.io/TITAN-Runner/ops/ in a browser without the demo flag. It reads the mirrors. The Security panel needs a sign-in, so Shreyas does that part.
9. **Update the record.** Mark the open items in `docs/DAILY_ASSISTANT_PROGRESS.md`. Write the result in `docs/DAILY_ASSISTANT_REPORT.md` and open a pull request. Merge it with a merge commit when the checks pass.

## Known open points

- **OpenRouter free models change often.** Discovery takes the first free model, and some of them answer 403 (only for agent harnesses) or return no text. The eval of 2026-10-12 gave `nvidia/nemotron-3.5-lightning:free` a score of 0.86 over 14 tasks. Shreyas can pin it with the Actions secret `OPENROUTER_MODEL`.
- **Dependabot.** See `docs/handoff/NEXT.md`. The `postcss` and `source-map-js` alerts come from `next` itself.
- **Pull request 22** (the draft of the owner) changes the same `uses:` lines as the hardened workflows. It may need a rebase.
