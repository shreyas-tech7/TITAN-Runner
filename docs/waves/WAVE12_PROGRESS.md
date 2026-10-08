# Wave 12 progress

Read this file and `WAVE12_BRIEF.md` again after a context compaction. Update this file after each item. Each row has the item ID, the status, and the next step.

Branch: `wave-12` (Release 1). Base: `origin/main` at `8e75efb`.

| Item | Status | Next step |
|---|---|---|
| Phase 0 | Done | |
| D1, D2 (STE standard and check) | Done in the Runner | Copy to TITAN |
| K1 provider catalog and gate | Done | |
| K2 true key status | Done, tests pass | Dashboard page (K7) |
| K3 save and verify | Done, tests pass | |
| K4 remove, test now, audit | Done, tests pass | |
| K5 runner proof | Done (workflow, script, route) | Live check needs a key |
| K6 more key types, openai_compat | Done | |
| K7 Keys page | Not started | Next |
| K8 callback token | Done in the Worker and workflows | Settings button in K7 |
| K9 stuck task reaper and retry | Done, tests pass | Retry button in the dashboard |
| K10, K11, K12 | Done. Seal in workerd: WebCrypto 0.16 to 0.4 ms, tweetnacl 1.3 to 2.4 ms for each seal | Playwright scenarios after K7 |
| S1 to S4 | Done, tests pass | S5 threat model, S6 scan patterns, S7 |
| R1 pulse keeper | Done in the Worker and the workflow | Dashboard banner, gap stats |
| R4, R5, R6 | Done in the Worker | |
| R2, R3 | R3 done (daily light probe). R2 not started | R2 |
| C, H, M, T | Release 2 | |
| A, Q, X, V, M5 | Release 3 | |
| P1 to P8 | TITAN repo | After Release 3 |

## Notes for a restart

- The Runner repo is `/workspaces/TITAN-Runner`. The TITAN repo is `/workspaces/TITAN`. Both have the branch `wave-12`.
- Run one heavy process at a time. Set `NODE_OPTIONS=--max-old-space-size=1536`.
- The Worker fake D1 uses `node:sqlite`. It needs Node 22.13 or newer.
- Do not use the words "self-improve" in a branch name. The denylist gate blocks it.
