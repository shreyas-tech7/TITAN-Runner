/**
 * @file The engine's declared capabilities — what the benchmark harness
 * probes to decide whether a scenario is meaningful for the code under
 * test. A name is added here only once the capability is wired end to end
 * and has a test that can fail; the harness records a scenario as
 * "not supported" (never "pass") when its requirement is missing.
 *
 * @type {readonly string[]}
 */
export const CAPABILITIES = Object.freeze([
  'lifecycle-state-machine', // one transition table, enforced in one place (task/lifecycle.js)
  'leases',                  // lease-based ownership with expiry + reconciliation (task/leases.js, task/reconcile.js)
  'checkpoint-resume',       // durable checkpoints at step boundaries, resumed by a later pulse (engine/pulse.js)
  'pulse-budget',            // in-process time budget with a clean exit (engine/pulseBudget.js)
  'state-repair',            // schema-validated, versioned state with backup + repair (state/store.js)
  'event-log',               // append-only redacted event record (observability/events.js)
  'idempotency-keys',        // duplicate submissions do not run twice (issueSync.js)
  'idempotent-side-effects', // side effects keyed, ledgered, and checked before re-firing (engine/sideEffects.js)
]);

export default CAPABILITIES;
