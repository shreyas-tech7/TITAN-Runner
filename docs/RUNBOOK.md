# Runbook

What to do when something is wrong, in the order you will want it. Every
command below works without a provider key. `titan` is `node bin/titan.js`.

## Stop everything, now

1. **Kill switch** (the pulse still runs, reconciles, and heartbeats, but
   claims nothing): Actions → *TITAN Control* → Run workflow → action
   `kill-switch`, target `on`, reason. Or locally: `titan control kill-switch on
   --reason "…"` then commit `state/control.json`.
2. **A running pulse**: Actions → *TITAN Pulse* → cancel the in-progress run.
   The task it held keeps its checkpoint; its lease expires
   (`TITAN_LEASE_TTL_MS`, 5 min) and the next pulse reclaims it — which it
   will not do while the kill switch is on.
3. **Stop the cron entirely**: Actions → *TITAN Pulse* → … → Disable
   workflow. `deadman.yml` will start filing `titan-alert` issues after 24 h
   of silence; that is it working.
4. **Turn it back on**: `kill-switch off`. Nothing else re-enables anything.

## Softer brakes

| Want | Do |
|---|---|
| Finish what is running, take nothing new | `drain on` |
| Keep working but post nothing and open no PRs | `safe-mode on` |
| Ask me before every external effect | `autonomy propose` |
| Ask me before every write and every external effect | `autonomy approval` |
| Reads only, nothing leaves the process | `autonomy dry-run` |
| Stop one task | `/titan cancel` on its issue (authorized users), or `cancel <taskId>` via the control workflow |
| Hold one task | `/titan pause`, later `/titan resume` |
| Push one task ahead | `/titan priority urgent` |

All of these are audited (`control.action`, `control.command` events with
`audit: true`) and stamped on `state/control.json` (`updatedBy`, `reason`).

## A task is stuck

```
titan explain issue-42     # status, what it waits on, how to unblock it
titan replay issue-42      # its whole event trail
```

| It says | Meaning | Do |
|---|---|---|
| `waiting (approval)` | a tool call or the delivery needs `/titan approve <key>` | comment `/titan approve <key>` (or `deny`) on the issue; keys are in the request comment |
| `waiting (provider)` / `(quota)` | every provider it can use is down, limited, or out of quota; wakes on the ladder 5 m → 3 h | nothing, unless a key is bad (`titan providers`); after `TITAN_MAX_PARKS` it dead-letters |
| `waiting (dependency)` | its `dependsOn` tasks have not completed | nothing; it dead-letters if one of them fails |
| `waiting (pulse-budget)` | the pulse ran out of time or calls mid-task | nothing; the next pulse resumes from the checkpoint |
| `paused` | a human paused it | `/titan resume` |
| `running` for > 15 min | the pulse holding it died | the next pulse reclaims it once the lease expires |
| `dead-lettered` | a poisoned loop, a budget ceiling, the park ceiling, a failed dependency | read `failure.code`, fix the cause, `/titan retry` |
| `failed` with `VERIFICATION_FAILED` | the work did not pass checks or the judge, even after remediation | read the Verification section of the issue comment; rephrase or `/titan retry` |
| `blocked` | the Reviewer Gate refused it | it will refuse again; rephrase the task |

## A provider is misbehaving

```
titan providers            # breaker per provider, why, quota used today
```

- `breaker disabled … key was rejected`: rotate the secret; the breaker
  clears on the next successful call (the weekly self-test, or a pulse).
- `breaker open … cooling down`: a 429 / 5xx; it clears itself. A long
  Retry-After is honoured by parking, never by sleeping the pulse.
- `quota … spent`: the ledger (`state/quota.json`) thinks the window is
  used up; raise `TITAN_QUOTA_<PROVIDER>_PER_DAY` if the tier is larger than
  the conservative default.

## State looks wrong

- The store validates every file on read and repairs a corrupt one from
  `state/backup/` (a `state.repaired` event says so); the bad bytes are kept
  under `state/quarantine/` locally. `titan doctor` reports what it did.
- To roll a state change back: `git revert` the state commit. v1 code
  ignores v2 fields; v2 code migrates a v1 file forward on read.
- A merge conflict in `state/` on the pulse's push: the pulse skipped that
  push and logged a warning; the next pulse recomputes from what is
  committed. Checkpoints (`TITAN_CHECKPOINT=git`) re-apply their own files
  onto the remote's version and keep the lease holder's copy of a task.
- Zombies (`running` with an expired lease), orphans (leases without a
  task), and waits past their TTL are reconciled at the start of every
  pulse (`reconcile.finished` event).

## Before pasting a new provider key

Run Actions → *Provider self-test*. It sends one tiny completion per
configured provider and records the result in `state/providers.json`; the
next pulse routes accordingly. Keys are never written to `state/`
(`scripts/check-secrets-in-state.mjs` and the diff scanner in CI refuse a
commit that contains one).

## Reproduce a problem without touching anything live

```
titan simulate --pulses 3                    # the built-in happy path against the fakes
titan simulate --script my-script.json --github my-fixture.json --state /tmp/sim
titan bench --filter provider-outage --keep  # a benchmark scenario, scratch kept
```

A fake-provider script (`src/fakes/fakeProvider.js`) can reply, stall,
return broken JSON, refuse, 429 with a Retry-After, 5xx, drop the
connection, run out of quota, or kill the process mid-step; the fake GitHub
is a JSON fixture. `TITAN_NETWORK=off` is set for you: nothing can reach a
real provider.
