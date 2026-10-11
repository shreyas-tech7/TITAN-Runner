# Wave 12 final report

## Executive summary

Wave 12 ("Keys That Work, Connectors, and a Better TITAN") is complete in `shreyas-tech7/TITAN-Runner`. All three releases (Release 1, Release 2, and Release 3) are built, verified with unit and integration tests in Node and the real Cloudflare `workerd` runtime, and checked against the ASD-STE100 Simplified Technical English standard.

## What shipped

### Release 1: Keys That Work, Pulse Keeper, and Security Baseline

- **Single provider catalog (`config/providers.catalog.json`):** One source of truth for all providers, synced across the Worker, dashboard, pulse engine, `.env.example`, and workflow env maps (`npm run check:providers`).
- **4-state cryptographic key pipeline (`worker/src/keys.js`, `dashboard/components/KeysPage.tsx`):** Validates format and base URLs, tests keys against the provider before saving, seals keys with X25519 + Blake2b + XSalsa20-Poly1305 (`crypto_box_seal` in WebCrypto with `tweetnacl` fallback), writes GitHub Actions secrets, and dispatches `provider-selftest.yml` for runner proof.
- **Runner callback token (`worker/src/callback.js`):** Automatic 32-byte token issuance, SHA-256 hash storage in D1, 30-day rotation with a 30-minute grace window, and `TITAN_STRICT_CALLBACK_AUTH` strict mode.
- **Pulse keeper (`worker/src/keeper.js`, `.github/workflows/keepalive.yml`):** 1-minute check that dispatches `titan-pulse` when the heartbeat is late and serves the public `GET /badge/pulse` SVG badge.
- **Security baseline (`worker/src/routes.js`, `worker/src/lib/auth.js`, `worker/src/lib/safeFetch.js`):** Explicit route groups (`public`, `admin`, `internal`, `mcp`, `hook`, `oauth`), wrong-token lockout, strict CORS allowlist, and `safeFetch()` outbound guard.

### Release 2: Connector Broker, MCP Server, Telegram, and Health Center

- **AES-256-GCM vault (`worker/src/lib/vault.js`):** Per-record 12-byte IVs and additional authenticated data (`connectionId` + `connectorId`), plus key rotation (`POST /admin/vault/rotate`).
- **15-connector broker (`worker/src/connectors/`, `connectors/*/manifest.json`):** Built-in connectors for arXiv, Weather, Hacker News, Wikipedia, RSS, GitHub, Discord, Slack, ntfy, Telegram, Inbound Webhook, Remote MCP, Notion, Google Calendar, Gmail, and Google Drive.
- **Risk policies and personal-data wall (`S7`, `C9`, `C10`):** Read actions run within rate limits, write actions create pending approvals, destructive actions require typed confirmation from an admin, and sub-agents are blocked from `personal` data connectors. Includes `src/tools/connectorCall.js`, `src/tools/connectorLoop.js`, `scripts/new-connector.mjs`, and `scripts/check-connectors.mjs`.
- **Two-way Telegram (`worker/src/connectors/telegram.js`):** Webhook secret verification, 10-minute single-use owner pairing code, HMAC-signed inline approval buttons, and commands `/status`, `/tasks`, `/new`, `/brief`, `/chat`, `/approve`, `/deny`, `/pause`, `/resume`, and `/help`.
- **Dual-era MCP server (`worker/src/mcpServer.js`):** Supports both `2024-11-05` and `2025-11-25` MCP protocol versions at `POST /mcp` with scoped tokens.
- **Health Center (`worker/src/health.js`, `dashboard/components/HealthPage.tsx`):** Unified health checks and setup checklist on `/health` and `/`.

### Release 3: Assistant Features, MCP OAuth 2.1, Demo Mode, and STE Docs

- **Instant chat (`worker/src/chat.js`, `dashboard/app/chat/page.tsx`):** `POST /chat` SSE streaming for OpenAI-compatible providers and Google Gemini (`:streamGenerateContent?alt=sse`), automatic pre-first-token failover across `alsoForChat` keys, user-configurable provider order (`POST /chat/order`), thread history in D1, and one-click "Make this a task".
- **Schedules (`worker/src/schedules.js`, `dashboard/components/SchedulesPanel.tsx`):** 5-field cron parser with IANA time zone and DST handling (`America/Chicago`), 1-minute tick (max 3 due schedules per tick), built-in daily brief schedule, and next-3-runs preview.
- **Daily brief (`worker/src/schedules.js`, `dashboard/components/BriefCard.tsx`):** Morning summary combining weather, calendar, tasks, approvals, keys, research digest, and health checks, with optional AI summary and browser `window.speechSynthesis` "Read aloud".
- **Unified approvals and pulse issue comments (`worker/src/schedules.js`, `dashboard/components/ApprovalsPanel.tsx`):** Approving or denying a pulse issue from the dashboard or Telegram posts `/titan approve <key>` or `/titan deny <key>` on the GitHub issue.
- **Unified activity timeline (`worker/src/schedules.js`, `dashboard/components/ActivityPanel.tsx`):** Chronological feed of tasks, key events, connector calls, approvals, schedules, and Worker deploys (`GET /activity`).
- **MCP OAuth 2.1 with PKCE (`worker/src/mcpOauth.js`, `dashboard/components/McpPanel.tsx`):** `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `POST /oauth/mcp/register` (allowlisted Claude and localhost redirect URIs), `/oauth/mcp/authorize` consent flow, and `POST /oauth/mcp/token` with mandatory `S256` PKCE and refresh token rotation.
- **Portfolio polish (`dashboard/lib/demoFixtures.ts`, `dashboard/app/how-it-works/page.tsx`, `README.md`):** Read-only `?demo=1` mode with fixture data across every tab, `/how-it-works` architecture page, Mermaid diagram, and live pulse badge.

## Benchmark and test results

- **Workerd sealed-box benchmark (`worker/test/workerd.test.mjs`):** WebCrypto X25519 sealed box takes **0.14 ms** per seal in `workerd` (well under the 5 ms budget). The `tweetnacl` fallback takes **1.62 ms** per seal.
- **Root test suite (`npm test`):** Passes all pulse, provider, security, and sub-agent connector tests.
- **Worker test suite (`npm --prefix worker test`):** Passes 235 tests across 12 test files, including 6 real `workerd` runtime tests.
- **Dashboard test suite and static export (`npm --prefix dashboard test && npm --prefix dashboard run build`):** Passes 93 component and logic tests and exports all 11 static routes.
- **STE documentation check (`node scripts/check-ste.mjs`):** Passes with 0 hard failures and score above 90%.

## Cross-repo note (`shreyas-tech7/TITAN`)

Per Section 3.1 rule 1 of the Wave 12 brief, access to the private repository `shreyas-tech7/TITAN` was tested via `gh api repos/shreyas-tech7/TITAN` and returned `GraphQL: Resource not accessible by integration (repository)`. The sandbox GitHub App token is scoped only to `shreyas-tech7/TITAN-Runner`. All Runner-side APIs remain ready for the private TITAN backend proxy, and the exact follow-up steps for `shreyas-tech7/TITAN` are in `docs/waves/WAVE12_HANDOFF.md`.
