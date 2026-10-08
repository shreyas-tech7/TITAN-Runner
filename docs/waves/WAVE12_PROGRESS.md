# Wave 12 progress

Read this file and `WAVE12_BRIEF.md` again after a context compaction. Update this file after each item.

Release 1 (K, S, R, vault-provision, callback-ping): merged and deployed. Live proof is in the report.
Release 2 is on the branch `wave-12-r2`. It is not merged. No pull request is open yet.

| Item | Status | Next step |
|---|---|---|
| C1 manifest format, schema, generator | Done. 19 connectors, 73 fixture tests pass | |
| C2 vault | Done in release 1 | |
| C3 broker, policies, approvals, call log | Done, tests pass | |
| C5 built-in connectors | Done (19) | Live check of the public routes after deploy |
| C6 inbound webhooks (hmac, github, static) | Done, tests pass | |
| C7 notification router and rules | Done, tests pass | Settings UI |
| C8 OAuth with PKCE | Done against a fake server, tests pass | |
| C9 `connector_call` tool and loop | Code written (`src/tools/connectorCall.js`, `connectorLoop.js`, `run-subagent-task.mjs`). NOT tested | Tests with a fake Worker, S7 state test |
| C10 `connectors:new` and `connectors:check` | Not started | Add scripts and npm entries |
| H1 H2 H3 H4 health | Done in the Worker, tests pass | Dashboard pages |
| M1 M2 MCP server and tokens | Done, tests pass | MCP Inspector proof against `wrangler dev` |
| M3 remote MCP client | Done, tests pass (modern, legacy, SSE) | |
| M4 "Use TITAN from Claude" card | Not started | Dashboard |
| T1 to T5 Telegram | Done, tests pass | The pulse approval comment (T4) comes with A4 |
| S6 secret patterns | Done, tests pass | |
| S7 personal data tests | Broker half done. State and log half not done | Test for the runner tool |
| S5 threat model rows | Not started | `docs/runner-upgrade/THREAT_MODEL.md` |
| Dashboard: Connectors, Health, tabs, command palette, Settings, setup ring | Not started | Next big piece |
| Docs: CONNECTORS, MCP, HEALTH, RUNTIME, CONFIG, RUNBOOK, DATA_CONTRACT, CHANGELOG, DECISIONS | RUNTIME route table updated only | Write them |
| e2e and a11y for new pages | Not started | |
| Workerd test of the new routes | Not started | |
| PR, merge, deploy, live checks for release 2 | Not started | |
| A, Q, X, V, M5 | Release 3 | |
| P1 to P8 | TITAN repo | After release 3 |

## Notes for a restart

- The Runner repo is `/workspaces/TITAN-Runner`. The TITAN repo is `/workspaces/TITAN`.
- Run one heavy process at a time. Set `NODE_OPTIONS=--max-old-space-size=1536`.
- GitHub push protection blocks real-shaped fake credentials. Write `@@FAKE:name@@` in fixtures. See `worker/test/helpers/fakeValues.mjs`.
- Do not use the words "self-improve" in a branch name.
- Generator scripts for the manifests are in the session scratchpad only. The manifests and fixtures in `connectors/` are the source now. Edit them by hand.
- The full Worker suite once hung on one test when run with all files. Each file passes alone. Check `worker/test/security.test.mjs` S4 in a full run.
