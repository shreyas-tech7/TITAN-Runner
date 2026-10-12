# Steps that need a person

This file lists what is still open after the daily assistant run. Only the owner can do these steps, because they need a secret value or a decision. This file holds no secret value. When they are done, a Claude Code session follows `docs/handoff/after-secrets.md`.

## Secrets (Shreyas pastes each value himself)

Make each random secret with `openssl rand -hex 32` in your own terminal, or with a password manager. Never paste a value into a chat.

1. **`OPS_TOKEN`.** One random secret of 32 characters or more. The same value goes in three places. The first is the Actions secret `OPS_TOKEN` (https://github.com/shreyas-tech7/TITAN-Runner/settings/secrets/actions/new). The second is the Worker secret `OPS_TOKEN` (Cloudflare, Workers & Pages, `titan-runner-brain`, Settings, Variables and Secrets, Add, type Secret, then Deploy). The third is the environment of TITAN. Until it is set, every `/ops` route answers 401, and the workflows do not post to the Worker.
2. **Doorbell.** Two Actions secrets. `DOORBELL_TOKEN` has the same value as in the environment of TITAN. `TITAN_BACKEND_URL` is the public address of the TITAN backend. Without them, `doorbell.yml` skips every run.
3. **Host addresses (optional).** Actions secrets `HOST_URL_HF_SPACE`, `HOST_URL_RENDER_1` to `3`, and `HOST_URL_HERMES_1` to `3`. The probe skips a host with no address. The repository variable `GEV_URL` already names the God's Eye View host, and the probe checks it.
4. **Discord (optional).** The Actions secret `DISCORD_WEBHOOK_URL` sends a short message when a host alert opens or closes.
5. **OpenRouter model (optional).** The free models of OpenRouter change often, and some of them only work inside agent tools. The Actions secret `OPENROUTER_MODEL` pins one. The eval of 2026-10-12 scored `nvidia/nemotron-3.5-lightning:free` at 0.86 over 14 tasks.
6. The Actions secret `GROK_API_KEY` is not used by any provider in the catalog. Delete it, or add a provider for it.

## Repository settings (the repo rule forbids Claude Code from changing them)

7. Optional: turn on "Validity checks" and "Non-provider patterns" at https://github.com/shreyas-tech7/TITAN-Runner/settings/security_analysis. Both are free on a public repo. Dependabot alerts, Dependabot security updates, secret scanning, and push protection are on (checked 2026-10-12).

## One check only you can do

8. Open https://shreyas-tech7.github.io/TITAN-Runner/ops/ in a private window. It must show the lock screen. Sign in with your admin token, and look at the Ops tab and the Security panel.

## Pull requests of yours

9. Pull request 22 (your draft that bumps the pinned actions) changes the same `uses:` lines as the hardened workflows. It may need a rebase on `main`.

## Dependabot (checked 2026-10-12)

10. Pull requests 34 and 36 are merged, and pull request 35 was the same change as 34. The open alerts went from 15 to 6. Pull request 47 sets overrides for the packages that `next` pins (`postcss`, `sharp`, `source-map-js`). It closes the other 6 when it merges.

## Rotation

11. The full history scan found no real key (1151 commits, 2026-10-12). Issues and pull requests have none either. Nothing to rotate.
