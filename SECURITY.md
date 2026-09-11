# Security policy

TITAN-Runner is a **public** repository by design — GitHub Actions is free
and unlimited on public repos, and that is what makes the "free forever"
premise true. The flip side is that *everything* the pulse commits is
world-readable, forever, cached and indexed regardless of any later revert.
Safety is therefore a design property, not a checklist. This document is
both the policy and a plain-language map of how that property is enforced.

## The public-sink rule

Two sinks are permanent and public:

1. **`state/`** — every task, prompt, model output, and run record the pulse
   ever produces, committed to git.
2. **Issue comments** — every summary and file preview the pulse posts back
   to a `titan-task` issue.

Anything sensitive must never reach either sink. The layers below exist to
make that true *even when a human forgets*, but they are backstops, not
permission to paste secrets on purpose.

## Defence in depth

| Layer | What it does | Where |
|-------|--------------|-------|
| Redaction | Scans every string value for credential-shaped patterns (keys, tokens, `Bearer` headers, long hex/base64 runs) and email addresses before anything is persisted. | `src/lib/redact.js` |
| State scrub | Applies the redaction scan to every value written under `state/` (without blanking whole `prompt`/`output` fields, which are the deliverable). | `src/lib/secretScrub.js` |
| Prompt screening | Deterministic, warn-only detection of injection/instruction-override/exfiltration intent on incoming task text and outgoing content. | `src/lib/promptScreen.js` |
| Reviewer Gate | Layer-1 policy + Layer-2 model review that can **block** a task or self-improvement proposal that looks destructive; fails closed for destructive-tier actions when the model is unreachable. | `src/reviewer/` |
| Secret scan (CI) | Independent scan of committed `state/` in CI; fails the build on a hit. | `scripts/check-secrets-in-state.mjs` |
| Denylist | A fixed list of paths the self-improvement flow may never touch, and that CI fails any PR for. | `src/denylist.js` |
| Loop protection | A `GITHUB_TOKEN` push never re-triggers the pulse; code changes only move through human-reviewed PRs. | `.github/workflows/titan-pulse.yml` |

## Reporting a vulnerability

If you find a way to defeat any of the above — a secret-shaped string that
survives redaction, a prompt that slips the Reviewer Gate, a path that the
denylist misses, or a workflow that can be induced to push code — **do not
open a public issue** (the whole point is that this repo is indexed).

Instead, report it privately to the repository owner:

- Open a GitHub **Security Advisory** (Security tab → "Report a
  vulnerability"), or
- Contact the maintainer directly.

Please include: what you did, what you expected, what happened, and (if you
have it) a minimal reproducer. Reports that show a concrete bypass are
prioritised; the maintainer will acknowledge within a few days and keep you
posted on a fix.

## Security fixes

Secret-handling code (`src/lib/redact.js`, `src/lib/secretScrub.js`), the
Reviewer Gate (`src/reviewer/`), the denylist, and all workflows are
**maintainer-mediated**: they sit behind the same denylist gate that binds
the self-improvement flow, and changes to them land only via a human-
reviewed PR. That is deliberate — it is the security model, not a bug to
route around.
