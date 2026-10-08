# Wave 12 progress

Read this file and `WAVE12_BRIEF.md` again after a context compaction. Update this file after each item. Each row has the item ID, the status, and the next step.

Branch: `wave-12` (Release 1). Base: `origin/main` at `8e75efb`.

| Item | Status | Next step |
|---|---|---|
| Phase 0 | In progress | Finish the TITAN read, then start K1 |
| D1 (STE standard) | Not started | Write `docs/STE.md` and `scripts/check-ste.mjs` |
| K1 to K12 | Not started | K1 provider catalog |
| S1 to S7 | Not started | After K |
| R1 to R6 | Not started | R1 early, after K8 |
| C, H, M, T | Release 2 | |
| A, Q, X, V, M5 | Release 3 | |
| P1 to P8 | TITAN repo | After Release 3 |

## Notes for a restart

- The Runner repo is `/workspaces/TITAN-Runner`. The TITAN repo is `/workspaces/TITAN`. Both have the branch `wave-12`.
- Run one heavy process at a time. Set `NODE_OPTIONS=--max-old-space-size=1536`.
- The Worker fake D1 uses `node:sqlite`. It needs Node 22.13 or newer.
- Do not use the words "self-improve" in a branch name. The denylist gate blocks it.
