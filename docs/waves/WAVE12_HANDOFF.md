# Wave 12 handoff

Use the block below in a session that has access to your private `shreyas-tech7/TITAN` checkout and your browser accounts.

```text
Wave 12 ("Keys That Work, Connectors, and a Better TITAN") is live on main in shreyas-tech7/TITAN-Runner.

1. Verify the live deployment on shreyas-tech7/TITAN-Runner:
   - Open https://shreyas-tech7.github.io/TITAN-Runner/?demo=1 to preview the read-only demo mode across Dashboard, Chat, Connectors, Keys, Health, and How It Works.
   - Unlock https://shreyas-tech7.github.io/TITAN-Runner/ with your TITAN_ADMIN_TOKEN.
   - Open /health and check the Setup Checklist. If CONNECTOR_KEK is not set yet, run the "Provision vault key" workflow (.github/workflows/vault-provision.yml) once from the Actions tab.
   - Open /keys, add or test your free provider keys (Groq, Google Gemini, OpenRouter), and tick "Also use for instant chat" on the keys you want to use in /chat.

2. Optional Google OAuth setup (only if you want Google Calendar, Gmail draft/read, or Google Drive):
   - In Google Cloud Console, create an OAuth 2.0 Web Client with redirect URI:
     <YOUR_WORKER_URL>/oauth/google_calendar/callback
     (and /oauth/gmail/callback or /oauth/google_drive/callback as needed).
   - Connect the tool on /connectors.

3. Sync the private shreyas-tech7/TITAN repository (blocked in the Runner sandbox because the GitHub App token is scoped only to TITAN-Runner):
   - Append a Wave 12 entry to 99 System/Changelog.md in shreyas-tech7/TITAN noting that Wave 12 shipped in TITAN-Runner (4-state keys, 15-connector broker, AES-256-GCM vault, dual-era MCP server with OAuth 2.1 + PKCE, instant chat SSE, schedules, daily brief, and Health Center).
   - Point TITAN's runner proxy routes at the new TITAN-Runner Worker endpoints (/admin/keys, /connectors, /chat, /schedules, /brief, /activity, /health/full).
```
