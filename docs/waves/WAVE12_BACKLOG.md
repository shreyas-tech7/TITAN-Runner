# Wave 12 backlog: improvements the brief does not name

Written in Phase 0 after a read of the code, the workflows, the live state, and the docs. Each item has a priority and a reason. Track X builds the P1 items first and then the P2 items. The last column is updated during the run.

| # | Item | Priority | Reason | Status |
|---|---|---|---|---|
| X1 | Flag a secret with a misspelled name, such as `GROK_API_KEY` | P1 | A real case in the live repo. Groq reads `not_configured` because of it. | done |
| X2 | A Worker fallback that applies missing migrations on the first tick | P1 | If the Cloudflare token cannot edit D1, the deploy step cannot make the new tables. The fallback keeps the Worker alive. | done |
| X3 | A "Run pulse now" button that dispatches `titan-pulse` | P1 | The keeper uses the same dispatch. A person should have the same power. | done |
| X4 | A `check:all` script that runs the whole push gate in one command | P1 | Section 8 asks for the same gate before each push. One command prevents a skipped step. | done |
| X5 | A test that the CSP gains no new host | P1 | Decision W12-D10 is a rule. A test makes it hold. | done |
| X6 | A CI job for the Worker tests | P1 | The old Worker tests never ran in CI. | done |
| X7 | A "Test all keys" button on the Keys page | P1 | One click replaces five. It also feeds the setup checklist. | done |
| X8 | Cancel a queued sub-agent from the dashboard (`POST /tasks/:id/cancel`) | P1 | Retry exists. A person also needs a way to stop a task before dispatch. | done |
| X9 | Webhook delivery log (metadata only) with the accept or reject reason | P1 | A person cannot fix a webhook without seeing why it failed. | done |
| X10 | A "Preview mapping" button for an inbound webhook | P1 | The brief template uses `{{body.field}}`. A preview catches a wrong field before the first real call. | done |
| X11 | A warning for stale keys (older than 90 days) through the notify router | P1 | Free keys expire or get revoked. A quiet reminder prevents a surprise. | done |
| X12 | Show the request id in every UI error | P1 | R5 returns the id. The UI must show it, or the id has no use. | done |
| X13 | Time zone setting for quiet hours and schedules | P1 | The default is `America/Chicago`. A person who travels needs to change it. | done |
| X14 | Per-connector call counters and rate-limit state in the drawer | P1 | A person cannot tune a limit without seeing the use. | done |
| X15 | MCP token expiry (optional `expires_at`) | P1 | A token for a short job should end by itself. | done |
| X16 | Deploy markers on the activity timeline from `/version` changes | P1 | A5 asks for deploys. This is how to find them without a new data source. | done |
| X17 | A Telegram `/pause` and `/resume` pair for the pulse | P1 | The kill switch must be reachable from a phone. It reuses the `/titan` comment commands. | done |
| X18 | A daily usage counter for Worker requests | P2 | The free plan allows 100,000 requests each day. A meter shows the margin. | done |
| X19 | Idempotency key on `POST /tasks` | P2 | A double click or a Telegram retry should not make two tasks. | done |
| X20 | Strict mode that removes the admin fallback on `/internal/*` | P2 | After legacy mode ends, the fallback code is attack surface. A flag removes it. | done |
| X21 | A user-set provider order for chat | P2 | The catalog order is a good default. A person may prefer another. | done |
| X22 | Audit export as CSV | P2 | R6 exports JSON. A spreadsheet is easier for a person to read. | done |
| X23 | A skip link and `aria-live` regions for status changes | P2 | Section 6 asks for keyboard use. These two help most. | done |
| X24 | A nightly Playwright smoke job | P2 | A broken page should show up before a person opens it. The job uses free minutes. | done |
| X25 | Pulse view refresh after a key is removed | P2 | `state/providers.json` keeps the old entry until the next self-test. | done |
| X26 | A shortcut sheet opened with `?` | P2 | A seed item from the brief. It costs little. | done |
| X27 | Saved task templates | P2 | A seed item from the brief. | done |
| X28 | A free quota meter for each provider each day | P2 | A seed item from the brief. `state/quota.json` already holds the data. | done |
| X29 | An "Explain this failure" button | P2 | A seed item from the brief. The CLI already has the explain logic. | done |
| X30 | A clear banner for safe mode and drain | P2 | A seed item from the brief. | done |
| X31 | A weekly report of what TITAN did | P2 | A seed item from the brief. | done |
| X32 | Vault key rotation with re-encryption | P2 | A seed item from the brief. C2 step 7. | done |
| X33 | Global search over tasks, connectors, and docs | P2 | A seed item from the brief. | done |
