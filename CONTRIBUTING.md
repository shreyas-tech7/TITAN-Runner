# Contributing to TITAN-Runner

Thanks for helping. TITAN-Runner is deliberately small and dependency-free;
the bar for a change is "would I trust this to run unattended, for free,
forever, on a public repo?" This file is the short version of how to clear
that bar.

## The two rules that are never negotiable

1. **Tests never touch the network.** Every test in `test/` must pass with
   zero credentials and zero network access — `npm test` is the CI gate and
   the local dev loop. Use the existing fixtures (`src/agents/fixtures/`),
   injectable-path helpers, and fake adapters; do not add a test that needs
   a key or a live endpoint.

2. **Protected paths are off-limits to automated PRs.** CI fails any PR
   whose diff touches a denylisted path: `.github/workflows/`,
   `src/denylist.js`, `src/reviewer/`, `src/lib/redact.js`,
   `src/lib/secretScrub.js`, `scripts/check-denylist.mjs`,
   `scripts/check-secrets-in-state.mjs`. Changes there are welcome but are
   **maintainer-mediated** — coordinate with the maintainer rather than
   pushing a PR that the gate will reject.

## Getting started

```bash
npm install
npm test                 # 125+ tests, zero network
npm run pulse:dry        # a full offline pulse against fixtures
```

Run the dashboard locally (optional):

```bash
cd dashboard && npm install && npm run dev
```

## Making a change

1. Open an issue describing the problem first, or comment on an existing
   one — small repo, short queue.
2. Branch, change, and keep each PR to **one idea** so it is trivially
   reversible.
3. Add/update tests. The bar is "would this still be obviously-correct in a
   year?"
4. Run `npm test`, `npm run check:secrets`, and (for PRs) the denylist gate
   locally before pushing.
5. Push and open a PR. CI runs the full suite, the secret scan, and the
   denylist gate.

## Conventions that keep this repo healthy

- **The repo is the database.** State lives only in committed `state/*.json`.
  New capability must fit that model, or be an explicit, optional external
  integration — never a hidden server or a secret side-channel.
- **Degrade, don't crash.** A missing key, dead provider, or flaky network
  must shrink the result, never kill the pulse. New code should follow the
  existing fail-soft pattern (`readJson` fallbacks, `safeCommentOnIssue`,
  `pruneRuns`'s digest-before-delete).
- **Redact before you log or persist.** Any new string that reaches a log
  line or `state/` must be passed through `redactString` / `scrubForState`
  first. Never log raw prompts or responses.
- **Behaviour changes ship behind a flag or fixture** (`TITAN_*` env vars,
  routing hints, opt-in YAML fields) and default to today's behaviour.
- **One commit message per change**, conventional-commit style, so history
  stays bisectable.

## Where things live

- `docs/ARCHITECTURE.md` — the pulse lifecycle and state model.
- `docs/RUNTIME.md` — how a pulse actually executes, minute-budget math.
- `docs/ROADMAP.md` — the long-horizon improvement plan (aspects A–M).
- `docs/IMPROVEMENT_PLAN.md` — the first implementation pass's plan + status.
- `docs/adr/` — architecture decision records for the big calls.

## License

By contributing you agree your work is licensed under the repo's MIT license.
