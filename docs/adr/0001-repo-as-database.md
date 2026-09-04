# ADR 0001: The repo is the database

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

A GitHub Actions runner is wiped clean after every job. If a pulse wants to
remember *anything* — which tasks exist, which models have been reliable,
when it last ran — that memory must live somewhere that survives the wipe.
The original TITAN backend ran a persistent server with a database and a
vault; TITAN-Runner runs as a scheduled workflow with no server at all.

## Decision

Every durable fact is committed to git, under `state/`. There is no SQLite,
no hosted store, no in-memory-only cache that matters across runs. The pulse
reads `state/*.json` at the start of a run, mutates in memory, and the
workflow commits the changed files at the end. "The repo IS the database."

## Consequences

- **Good:** zero infrastructure to run or pay for; full audit history for
  free (every state change is a commit); a corrupt or lost runner is
  harmless (the committed state is the truth, not the runner).
- **Good:** state is readable by the static dashboard via plain
  `raw.githubusercontent.com` fetches — no backend needed.
- **Cost:** state is public and permanent. Every prompt and output committed
  here is world-readable forever, which is why redaction, state scrubbing,
  the Reviewer Gate, and the CI secret scan are load-bearing, not optional.
- **Cost:** state files grow with history, so retention is explicit:
  `state/runs/` and finished `state/tasks.json` entries are compacted into
  `state/digests/` rather than deleted silently.

Alternatives considered: a serverless KV/object store (adds an account, a
bill, and a secret to protect — against the free-forever premise); GitHub
Artifacts as storage (expire, and are awkward for the dashboard to read).
Both were rejected for the committed-state model.
