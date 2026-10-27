# Changelog

## HUD redesign

- Make the home page an assistant first screen. The AI core, a greeting, and the chat are at the center. See `docs/HUD.md`.
- Move the dashboard panels into a collapsible Systems Deck with the tabs Overview, Daily Brief, Co-Processors, God's Eye, and Schedules.
- Replace the red pulse banner with the system pill `SYS_WARNING`. A click opens the detail.
- Rename the Agent status board to Sub-agent co-processors. Each provider shows a role.
- Rename the Daily Brief to the Morning Operational Brief. The full text folds open.
- Add voice input to the chat and a wave for Read aloud.
- Add orbit rings, satellites, and particles to the God's Eye globe.
- Change the Eclipse theme to obsidian, electric cyan, and stark gold. Add glass panels, corner brackets, and gridlines.
- Rename the first tab from Dashboard to Core.

## Wave 13 (overnight wave)

- Add the public repository check `scripts/check-public-pii.mjs`. It finds personal data and keys in `state/`, in the built Pages site, and in Issues.
- Fix: the Pages deploy failed on every push to `main`. The `card-number` rule read the digits after the decimal point in the shader code of three.js as a card number. The rule now skips the digits of a decimal number. A card number in plain text is still found.
- Fix: the OpenRouter check stayed in the `error` state with "returned no message content". The self-test asks for 5 tokens. A model that thinks first uses all of them before it writes text. The adapter now sends at least 256 tokens in each request. A call that sets no budget keeps its default.

## Wave 12, release 1

- Add `config/providers.catalog.json`, the one source of truth for providers, with a CI gate for drift.
- Add the Keys page. It shows the true state of each key and checks a key with the provider before it saves it.
- Add `POST /admin/keys` with a provider check, a sealed box, an audit log, and a runner proof.
- Add custom OpenAI compatible providers, OmniRoute, and Hermes keys.
- Add the callback token. The Worker makes it and rotates it. Workflows use it and not the admin token.
- Add the stuck task reaper and the Retry button.
- Add the pulse keeper. The Worker starts a pulse when GitHub is late.
- Add one route table with a token group for each route, the wrong token lockout, and a CORS allowlist.
- Add `safeFetch()` for every outbound call of the Worker.
- Add D1 migrations, retention, export, and delete.
- Add OpenRouter model rotation and a Gemini preference.
- Add the daily light probe to the provider self-test.
- Add the vault key step to `worker-deploy.yml` and the workflow `vault-provision.yml`.
- Add the STE documentation standard and its check.
- Fix: the Worker entry module exported values that the current workerd refuses.

## Wave 12, release 2

- Add the AES-256-GCM vault in `worker/src/lib/vault.js` with per-record IVs and additional authenticated data.
- Add the connector broker in `worker/src/connectors/` with 15 manifests, risk policies, rate limits, and approvals.
- Add OAuth 2.0 with PKCE for Google Calendar, Gmail, and Google Drive.
- Add inbound webhooks with Bearer and HMAC-SHA256 verification and replay protection.
- Add the two-way Telegram bot with one-time pairing codes and HMAC inline approval buttons.
- Add the notification router with wildcard rules, severity filters, quiet hours, and deduplication.
- Add the dual-era MCP server (`2024-11-05` and `2025-11-25`) at `POST /mcp` and the MCP client connector.
- Add the Health Center on `/health` and the Setup Checklist on the home page.
- Add the sub-agent `connector_call` tool, the 3-call tool loop, and the `connectors:new` and `connectors:check` scripts.

## Wave 12, release 3

- Add instant chat (`POST /chat` SSE and `/chat`) with OpenAI and Gemini streams and automatic failover across `alsoForChat` keys.
- Add the 5-field cron schedule engine (`worker/src/schedules.js`) with time zone and DST support and the Schedules panel.
- Add the daily brief (`GET /brief`, `POST /brief/generate`, and `BriefCard`) with browser speech synthesis.
- Add unified pulse issue approvals (`POST /approvals/pulse`) and the unified Activity Timeline (`GET /activity`).
- Add OAuth 2.1 with S256 PKCE for the MCP server (`/.well-known/*`, `/oauth/mcp/register`, `/oauth/mcp/authorize`, `/oauth/mcp/token`).
- Add read-only demo mode (`?demo=1`) with deterministic sample data and the `/how-it-works` architecture page.

