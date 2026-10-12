# Cowork handoff 1: TITAN-Runner daily assistant

You are Claude Cowork. You work in the browser for Shreyas. This file holds everything you need. You do not need any other context.

## How to work

- Do not ask clarifying questions. Make the best choice and note it in your report.
- Pause only when a page asks for a required yes or no confirmation. Pause when Shreyas must paste a secret.
- Never turn on billing. Never add a card. Never create an account. Never type a password, a key, or a token yourself.
- Never show the value of a secret in the chat, in a screenshot, or in a report. Refer to a secret by its name.
- When Shreyas must paste a value, tell him which page and which field, and wait. He pastes the value himself. He never pastes it into the chat.
- Work through the steps in order. If a step cannot be done, write why in your report and go on to the next step.

## What Claude Code did already

Claude Code worked in the Codespace of the public repository `shreyas-tech7/TITAN-Runner`. It closed the trust gaps (secret scanning, hardened Issues, a gate for every GitHub write, Worker sessions, state hygiene). It built the shared ops services of the contract with TITAN (quota meter, nightly provider canary, weekly eval, post-mortems, host status, doorbell). It added the **Ops** page to the dashboard.

- Pull request 31 holds all the code, tests, and docs. It is merged into `main`. The Pages site and the Worker redeploy from `main` by themselves.
- The workflow changes are **not** on GitHub yet. They are six new workflows (gitleaks, state maintenance, provider canary, golden task eval, host status, doorbell) and edits to eight existing ones. A push that changes `.github/workflows/` needs the `workflow` scope, and the token in the Codespace does not have it. The files wait on a local branch named `claude/daily-assistant-wf`. Step 1 below fixes this. After that, Claude Code pushes the branch and opens pull request 2.

Useful values (none of them is a secret):

| What | Value |
|---|---|
| Repository | https://github.com/shreyas-tech7/TITAN-Runner |
| Dashboard | https://shreyas-tech7.github.io/TITAN-Runner/ |
| Ops page | https://shreyas-tech7.github.io/TITAN-Runner/ops/ |
| Ops page, sample data | https://shreyas-tech7.github.io/TITAN-Runner/ops/?demo=1 |
| Worker | https://titan-runner-brain.titan-runner.workers.dev |
| GitHub account | shreyas-tech7 |

Secrets that already exist in the repository (names only): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `GEMINI_API_KEY`, `GROK_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TITAN_ADMIN_TOKEN`, `TITAN_CALLBACK_TOKEN`. Variables that already exist: `GEV_URL`, `TITAN_WORKER_URL`.

## Steps

### Step 1. Fix push access for workflow files

This one needs the Codespace terminal.

1. Open https://github.com/codespaces. Open the Codespace for `shreyas-tech7/TITAN-Runner` in the browser.
2. In its terminal run this command:

   ```bash
   gh auth refresh -h github.com -s workflow
   ```

3. The terminal prints a one-time code and the address https://github.com/login/device. Open that address in a new tab. Enter the code. Choose the account `shreyas-tech7` only. Approve.
4. Back in the terminal, run `gh auth status`. The line "Token scopes" must now list `workflow` next to `repo`.

The one-time code is not a secret, but do not post it anywhere.

Report: yes or no, and the list of token scopes.

### Step 2. Repository security settings

Open https://github.com/shreyas-tech7/TITAN-Runner/settings/security_analysis. Set these:

| Setting | Wanted |
|---|---|
| Dependabot alerts | Enabled. It is off now. Click Enable. |
| Dependabot security updates | Enabled (optional, free). |
| Secret scanning | Enabled. It is on now. Leave it. |
| Push protection | Enabled. It is on now. Leave it. |
| Validity checks | Enabled (optional, free on a public repository). |
| Non-provider patterns | Enabled (optional, free on a public repository). |

Do not change any other setting on this page. Do not change branch protection.

Report: the state of each row after your changes.

### Step 3. The ops token `OPS_TOKEN`

`OPS_TOKEN` is one random secret. It must be the same value in three places. TITAN and the workflows use it to call the `/ops` routes of the Worker.

Ask Shreyas to make the value himself, with a password manager or with `openssl rand -hex 32` in his own terminal. It must have at least 32 characters. He keeps it in his clipboard. He never pastes it into the chat.

Then do these, and tell Shreyas to paste at each one:

1. **GitHub Actions secret.** Open https://github.com/shreyas-tech7/TITAN-Runner/settings/secrets/actions/new. Name: `OPS_TOKEN`. Shreyas pastes the value. Click Add secret.
2. **Worker secret.** Open https://dash.cloudflare.com. Go to Workers & Pages, then `titan-runner-brain`, then Settings, then Variables and Secrets. Click Add. Type: Secret. Name: `OPS_TOKEN`. Shreyas pastes the value. Click Deploy.
3. **TITAN.** Tell Shreyas to add the same `OPS_TOKEN` to the environment of TITAN (the other repository and host). You cannot do this one. Say so in your report.

Report: the names of the secrets that now exist on both pages. Never the value.

### Step 4. The doorbell secrets

The doorbell workflow rings TITAN. It needs two secrets and one address.

1. `DOORBELL_TOKEN`: a second random secret, made like the first one. Add it as a GitHub Actions secret on the page of step 3.1. Shreyas also adds the same value to the environment of TITAN as `DOORBELL_TOKEN`.
2. `TITAN_BACKEND_URL`: the public https address of the TITAN backend. Ask Shreyas for it. Add it as a GitHub Actions secret. It is also a secret, so do not show it. Shreyas also keeps it in his TITAN notes.

Without these two secrets, the doorbell workflow skips every run. That is not an error.

### Step 5. Host addresses (optional)

The host status workflow checks each host that has an address. A host with no address is skipped. Ask Shreyas which of these he runs. For each one he runs, add a GitHub Actions secret on the page of step 3.1, and he pastes the value:

| Secret name | Value |
|---|---|
| `HOST_URL_HF_SPACE` | `owner/name` of the Hugging Face Space, or its https://huggingface.co/spaces/owner/name address |
| `HOST_URL_RENDER_1`, `HOST_URL_RENDER_2`, `HOST_URL_RENDER_3` | The public https address of each Render service |
| `HOST_URL_HERMES_1`, `HOST_URL_HERMES_2`, `HOST_URL_HERMES_3` | The public https address of each Hermes agent on Railway |
| `DISCORD_WEBHOOK_URL` | A Discord webhook address for host alerts (Discord server settings, Integrations, Webhooks, New Webhook, Copy Webhook URL) |

The repository variable `GEV_URL` already names the God's Eye View host. Leave it.

Report: which of these secrets now exist (names only).

### Step 6. Checks on the live sites

Do these after steps 1 to 5. Do not type any token.

1. Open https://shreyas-tech7.github.io/TITAN-Runner/ops/?demo=1. The page must show these panels with sample data: Provider health, Quota meter, Host status, Eval scores, Lessons, and Security. Check the page at a phone width too (390 pixels wide). Nothing may scroll sideways. Report any panel that is missing or broken.
2. Open https://titan-runner-brain.titan-runner.workers.dev/version. Report the first 7 characters of the `commit` value. It should start with `e26c52f`, the merge commit of pull request 31. If it shows another value, the Worker deploy has not finished. Wait 5 minutes and look again.
3. Open each of these addresses in the browser: `/ops/quota`, `/ops/health`, `/ops/eval`, `/ops/hosts`, and `/ops/usage` on the Worker address above. Each must answer **401** with a short JSON body. A 404 or a 500 is a failure. Report the status of each.
4. Open https://shreyas-tech7.github.io/TITAN-Runner/ops/ without `?demo=1`. The lock screen must show. Do not sign in. Tell Shreyas to sign in himself with his admin token and to say if the Ops tab loads.

### Step 7. Tell Claude Code

Write the report as a prompt for Claude Code, as the last section of your answer.

## What to include in your report

- For each step: done, partly done, or not done, and why.
- The list of token scopes from step 1.
- The names of the secrets and variables that exist now. Never values.
- The status code of each address in step 6.
- Anything that looked wrong, even if it is not in the steps.

## Your closing instruction

When you finish, write a prompt for Claude Code that starts with "Continue the TITAN-Runner daily assistant run from Cowork handoff 1." Include what you completed, the non-secret values Claude Code needs (IDs, URLs), the names of secrets that are now set (never values), what failed and why, and the next steps. Tell Claude Code not to ask questions and not to stop without a deliverable outcome.

## What Claude Code does after your prompt arrives (for your information)

1. It pushes the branch `claude/daily-assistant-wf`, opens pull request 2 with the workflow files, and merges it with a merge commit when the checks pass.
2. It runs each new workflow once by hand (gitleaks, state maintenance, provider canary, golden task eval, host status, doorbell) and checks the output and the files that they commit.
3. It checks that the Ops page shows live data, and writes the completion report.
