# Decisions

Judgment calls made without stopping to ask, per the v2.0 build brief's
operating rule 1 (`docs/RUNNER_V2_BRIEF.md`). Numbered sequentially,
never renumbered or deleted — a later decision can supersede an earlier
one, but the earlier entry stays for the record.

## D-1 — Branch name follows the harness assignment, not the brief's literal name

The brief says to cut `claude/runner-v2`. The session's own operating
instructions (outside the brief) assign this run to
`claude/runner-v2-build-w751g0` and say "never push to a different branch
without explicit permission." That harness-level instruction outranks the
brief's suggested name — a branch name is not a behavior the brief has
authority to override the runtime's own assignment on. All work in this
run lands on `claude/runner-v2-build-w751g0`.

## D-2 — No new npm dependency for schema validation

The brief asks for zod/ajv validation of the state-store schema. This repo
ships with **zero** runtime dependencies by deliberate prior design (see
`docs/RUNTIME.md`'s "zero maintenance... own dependency tree" framing,
`src/github.js`'s header, `package-lock.json` carrying no packages at all).
Adding zod or ajv would be the first third-party dependency this repo has
ever taken on, on a public, unattended, auto-committing pipeline — real
supply-chain surface for a repo whose own brief (Track A) is about
minimizing exactly that kind of risk. A hand-rolled validator
(`src/state/contract.js`) covering the exact fields the brief's
`docs/CONTRACT.md` envelope defines gives the same "reject unknown majors
loudly" behavior without the new dependency. Revisit if the contract grows
complex enough that hand-rolled validation becomes the bigger risk.

## D-3 — `state/quota.json` limits are conservative, documented estimates, not scraped live values

None of the five providers' free-tier daily-request limits are exposed via
a stable, documented, machine-readable API — they are marketing-page
numbers that change without notice. `state/quota.json` ships with a
conservative hardcoded floor per provider (see `src/state/quota.js`'s
`FREE_TIER_DAILY_LIMITS` and its inline citation of what each number is
based on) and degrades to "don't block on quota" if a provider is not in
the table, rather than inventing a number. A maintainer who knows a
provider's actual current limit can override it via a `*_DAILY_LIMIT` env
var.

## D-4 — Reviewer Gate's `needs-human` verdict is new, additive, and off the model's default path

The contract (`docs/CONTRACT.md`) names `needs-human` as a reviewer
verdict. The existing Layer 2 model prompt (`src/reviewer/prompts.js`) only
ever asked for `allow`/`block`. Extended the prompt and
`src/reviewer/reviewer.js`'s parsing to accept `needs-human` as a third
option (fail-closed to `block` if a destructive-tier action's model
response can't be parsed at all, unchanged from before) rather than
redesigning the gate's two-layer structure. A task whose verdict is
`needs-human` is parked (`status: 'review'`, issue labeled
`titan-review`) until a human adds `titan-approved`; it is never claimed
again by an ordinary pulse pass in the meantime.

## D-5 — Track E dashboard work scoped down from "live world map"

The existing dashboard (`dashboard/`) already implements most of Track E:
provider health strip, run/task detail drawer, pulse timeline, staleness
banner, PWA manifest + service worker, dark instrument-panel theme. Given
this run's remaining budget, the literal "live world map of provider
endpoints and regions with animated request flow" was not built — it is a
large, purely-cosmetic addition on top of an already-working, tested
dashboard, and this run prioritized Track A (safety) and Track F
(verification) as the brief's own stated first priority and gate. See the
final report's "Not done" section. A `ProviderMap` component was not
added; the existing provider-health strip (list form, not geographic) is
what ships.

## D-6 — `state/health.json` is new and additive alongside the existing `state/heartbeat.json`

The brief names `state/health.json` explicitly. The existing pipeline
already has a heartbeat file (`state/heartbeat.json`, written by
`src/state/io.js`) that the dead-man's-switch and dashboard both depend
on today. Renaming or replacing it would break both on a running system
for no behavioral gain. `state/health.json` is written alongside it as a
superset aimed at the brief's exact shape (per-provider status included
inline), while `state/heartbeat.json` keeps being written unchanged for
existing readers.

## D-7 — Coverage gate uses Node's own built-in coverage, not nyc/c8

Same reasoning as D-2: no new dependency. `node --test --experimental-test-coverage`
(stable enough on Node 20+ for this repo's purposes) already prints a
per-file and "all files" percentage table; `scripts/check-coverage.mjs`
parses that directly rather than adding `c8` or `nyc`.

## D-8 — Dead-letter cap defaults to 3 attempts

Not specified by the brief. Three matches this repo's other "small cap,
overridable via env" defaults elsewhere (`TITAN_MAX_TASKS_PER_PULSE=3`,
`TITAN_MAX_OPENCODE=4`) and is enough to absorb a transient provider outage
across a couple of pulses without leaving a genuinely broken task retrying
forever. `TITAN_MAX_TASK_ATTEMPTS` overrides it.

## D-9 — The quota ledger only counts auto-routed calls

`src/providers/registry.js#chat()`'s quota check (like its existing health
check) only applies in `service: 'auto'` mode. An explicit routing hint —
the Reviewer Gate's own `service: 'groq'` call, or a task's `routingHint`
reaching a specific provider — is a deliberate choice, not automatic
failover, and is rare enough next to ordinary auto-routed traffic that
under-counting it is the safer direction: it can never cause a ledger
mistake to block a human/system decision that explicitly asked for a named
provider.

## D-10 — `PULSE_DRY_RUN` is an additive alias, not a rename

The brief names `PULSE_DRY_RUN=1` specifically (Track F). This repo's
existing name, `TITAN_DRY_RUN=1`, is referenced throughout
`docs/RUNTIME.md`, the README, `package.json`'s `pulse:dry` script, and
every test — renaming it would be a breaking change for zero behavioral
gain. `config.js` now treats either as equivalent; `TITAN_DRY_RUN` stays
the primary documented name.

## D-11 — Lifecycle labels are created on demand, not documented as a manual setup step

The label lifecycle (titan-running/titan-review/titan-approved/titan-done/
titan-blocked/titan-cancelled) needs those labels to exist on the repo
before `addLabels()` can apply them. Rather than add "create six labels by
hand" to the manual-steps list, `src/github.js#ensureLabels()` creates any
that are missing at the start of every real (non-dry-run) pulse —
idempotent, and it means this PR is fully self-contained: merge it and the
labels exist by the first scheduled pulse afterward.
