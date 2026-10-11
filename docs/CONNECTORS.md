# Connectors

A connector links TITAN to an outside tool. The Worker is the broker. It stores every secret in the encrypted vault and makes every outbound call. The browser and the GitHub runners never see a connector secret.

## Connect a tool in four steps

1. Open the Connectors page of the dashboard.
2. Pick a tool from the catalog and click "Connect".
3. Enter the required key, webhook link, or OAuth client values.
4. Click "Connect".

TITAN tests a read connector right away. A connector that sends a message on test waits until you click "Send test" in its drawer.

## The encrypted vault

- The Worker encrypts each secret with AES-256-GCM before it writes to D1.
- The key encryption key lives in the Worker secret `CONNECTOR_KEK`.
- Each record has its own 12-byte random IV.
- Additional authenticated data binds each ciphertext to its connection id and connector id.
- Run the workflow "Provision vault key" if the Connectors page says the vault needs setup.
- To rotate the vault key, set `CONNECTOR_KEK_PREV` to the old key, set `CONNECTOR_KEK` to the new key, and call `POST /admin/vault/rotate`.

## Risk levels and policies

Each action of a connector has a risk level and a policy mode.

| Risk | Default policy | What happens |
|---|---|---|
| `read` | `allow` | The Worker runs the call right away when the rate limit allows it. |
| `write` | `ask` | A call from a sub-agent or an MCP tool creates a pending approval row. It runs once after you click "Approve". |
| `destructive` | `deny` | Sub-agents and MCP tools cannot call it. Only an admin with a typed confirm string can run it. |

You can change the policy of any action in the connection drawer. You cannot set a destructive action to `allow` for sub-agents.

## Data classes and the personal data wall

Each connector and action has a data class: `public`, `internal`, or `personal`.

- `public` data comes from public sources such as arXiv, Hacker News, Weather, and Wikipedia.
- `internal` data covers operational channels such as GitHub, Telegram, Discord, Slack, and Ntfy.
- `personal` data covers private accounts such as Gmail, Google Calendar, Google Drive, and Notion.
- Sub-agents in this public repository cannot call any connector or action with the `personal` class.
- The sub-agent tool `connector_call` also scrubs secrets and personal data patterns before any output reaches `state/` or a log.

## Built-in connectors

| ID | Name | Category | Auth mode | Data class |
|---|---|---|---|---|
| `arxiv` | arXiv | research | none | `public` |
| `weather` | Open-Meteo Weather | utility | none | `public` |
| `hn` | Hacker News | news | none | `public` |
| `wikipedia` | Wikipedia | research | none | `public` |
| `rss` | RSS / Atom Feed | news | none | `public` |
| `github` | GitHub | code | bearer | `internal` |
| `discord_webhook` | Discord Webhook | notify | webhook | `internal` |
| `slack_webhook` | Slack Webhook | notify | webhook | `internal` |
| `ntfy` | ntfy | notify | bearer | `internal` |
| `telegram` | Telegram | chat | bot_token | `internal` |
| `inbound_webhook` | Inbound Webhook | automation | webhook_receiver | `internal` |
| `remote_mcp` | Remote MCP Server | mcp | bearer | `internal` |
| `notion` | Notion | knowledge | bearer | `personal` |
| `google_calendar` | Google Calendar | productivity | oauth2 | `personal` |
| `gmail` | Gmail | productivity | oauth2 | `personal` |
| `google_drive` | Google Drive | productivity | oauth2 | `personal` |

## Two-way Telegram bot

1. Talk to `@BotFather` on Telegram and create a bot token.
2. Connect the Telegram connector on the Connectors page with that token.
3. Open the Telegram connection drawer and click "Generate pairing code".
4. Send `/pair <CODE>` to your bot from your personal Telegram account within 10 minutes.

After you pair your chat, the bot answers only your chat id. It supports `/status`, `/tasks`, `/new <brief>`, `/brief`, `/chat <question>`, `/approve`, `/deny`, `/pause`, `/resume`, and `/help`. Plain text messages also go to instant chat when a chat key exists.

## Add a new connector

1. Run `npm run connectors:new -- <id> "<Title>" <category>`.
2. Edit `connectors/<id>/manifest.json` and `connectors/<id>/index.js`.
3. Add the host to `worker/src/lib/safeFetch.js` if it makes outbound HTTPS calls.
4. Run `npm run gen:connectors` and `npm run connectors:check`.
