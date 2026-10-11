# Health Center and Pulse Keeper

The Health Center on `/health` checks every part of TITAN in one place and gives you a direct fix when a check fails.

## What `GET /health/full` checks

| Group | Check | What it verifies |
|---|---|---|
| Core | Worker & D1 | The Worker answers and all D1 migrations are in sync. |
| Core | Version match | The commit in the dashboard build matches `/version` on the Worker. |
| Secrets | `GITHUB_PAT` | The Worker token can read the repo public key and write Actions secrets. |
| Secrets | `CONNECTOR_KEK` | The 32-byte AES-256-GCM key is present for the connector vault. |
| Runner | Callback token | `TITAN_CALLBACK_TOKEN` is active and recent runner pings succeeded. |
| Runner | Pulse keeper | `state/heartbeat.json` is fresh and the pulse is not paused. |
| Providers | AI keys | At least one provider key is proven in a GitHub runner. |
| Connectors | Connected tools | Every connected tool passed its latest test and needs no OAuth reconnect. |
| URLs | Watched URLs | Every URL in your health list answers with HTTP 2xx. |

## The Setup Checklist

The Setup Checklist appears on the home page until all five setup steps finish:

1. Deploy the Worker and set `TITAN_WORKER_URL`.
2. Give the Worker a fine-grained `GITHUB_PAT` with Actions, Secrets, Contents, and Issues permissions.
3. Save and prove at least one free provider key on `/keys`.
4. Verify runner callbacks with `TITAN_CALLBACK_TOKEN`.
5. Connect a notification channel such as Telegram, Discord, Slack, or ntfy.

## Runner callback token (`K8`)

Workflows authenticate to `/internal/*` with the header `X-Titan-Callback`.

- The Worker generates a 32-byte random token, stores only its SHA-256 hash in `worker_tokens`, and seals the plain value into the repo secret `TITAN_CALLBACK_TOKEN`.
- The 1-minute tick issues the first token automatically and rotates it every 30 days.
- During a rotation, the previous token stays valid for a 30-minute grace window so running workflows do not fail.
- For the first 30 minutes after the very first callback token becomes active, `/internal/*` also accepts `TITAN_ADMIN_TOKEN` (legacy mode). Set `TITAN_STRICT_CALLBACK_AUTH=1` to disable legacy mode at once.
- If a workflow callback fails, open Settings or `/health` and click "Repair runner callbacks".

## The Pulse Keeper (`R1`, `R2`)

GitHub Actions disables scheduled workflows after 60 days of repo inactivity and can drop cron runs under load. TITAN prevents silent pulse stalls in three layers:

1. **Worker 1-minute keeper (`worker/src/keeper.js`):** Checks the latest pulse heartbeat. If the pulse is more than 35 minutes late and not paused, the Worker dispatches `titan-pulse` with exponential backoff and emits `pulse.late` after two missed tries.
2. **Keepalive workflow (`.github/workflows/keepalive.yml`):** Runs weekly and refreshes workflow activity so GitHub does not disable the schedule.
3. **Public status badge (`GET /badge/pulse`):** Returns an SVG badge (`healthy`, `late`, or `paused`) for the `README.md` header.
