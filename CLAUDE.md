# TITAN-Runner: rules for agents

TITAN-Runner is the live, hosted TITAN. It is a public repo. Everything that you commit, every Actions log, every issue, and every file under `state/` is public. A push is a publication.

## Documentation standard

Write documentation in ASD-STE100 Simplified Technical English about 80 percent of the time. See docs/STE.md.

Obey the same rule in each new doc, code comment, commit body, pull request text, and prompt. Do not use em dashes or semicolons in prose. Run `node scripts/check-ste.mjs --base origin/main` before you push.

## Core rules

1. Spend $0. Do not add a card, a paid plan, a paid API, a paid domain, or a trial that becomes paid.
2. Never print, log, commit, or echo a secret. This covers keys, tokens, OAuth secrets, webhook URLs, and bot tokens.
3. Never put personal data (mail, calendar, notes, chat) in the repo, in `state/`, in an issue, or in a workflow log. The Worker handles it.
4. Never copy vault notes from the private TITAN repo into this repo.
5. Never use a branch name that starts with `self-improve/`. The denylist gate blocks it.
6. Never force push `main`. Never change branch protection or repository settings.
7. Keep every D1 migration additive. Migrations live in `worker/migrations/`.

## How the parts fit

- **Pulse**: `.github/workflows/titan-pulse.yml` runs `src/pulse.js`. The Worker keeper starts it when GitHub is late.
- **Worker**: `worker/` is the Cloudflare Worker `titan-runner-brain`. The entry module `worker/src/index.js` exports a default handler only. Every other function lives in its own module.
- **Provider catalog**: `config/providers.catalog.json` is the one source of truth for providers. Run `npm run sync:providers` after you change it. The CI gate `check:providers` fails on drift.
- **Tokens**: the admin token is for people. The callback token is for workflows. MCP tokens are for tools. See the table in `docs/RUNTIME.md`.
- **Dashboard**: `dashboard/` is a Next.js static export on GitHub Pages. It never calls a host that is not in its `connect-src` list.

## Words

Use the same word for the same thing:

- "key": a provider API key
- "token": a TITAN access token
- "secret": a GitHub Actions secret

## Commands

```bash
npm test                      # root tests
npm run test:worker           # Worker tests (Node 22.13 or newer)
cd dashboard && npm test      # dashboard tests
cd dashboard && npm run e2e   # browser tests (build the export first)
npm run check:workflows
npm run check:providers
npm run check:migrations
npm run check:ste
```

## Resource guard

Run one heavy process at a time: a `next build`, a full test suite, or a Playwright run. Set `NODE_OPTIONS=--max-old-space-size=1536`. Stop every dev server and watch process that you start.
