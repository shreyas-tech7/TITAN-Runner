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
  'failure-taxonomy',        // every failure classified; retry policy per class (reliability/failures.js, retryPolicy.js)
  'waiting-state',           // a task parks on provider outage / quota with a wake time instead of failing
  'output-repair',           // an unusable answer is repaired with a bounded re-prompt (reliability/outputRepair.js)
  'quota-ledger',            // per-provider windows tracked in state/quota.json and consulted before calls
  'breakers',                // per-provider breaker state derived from health, with explain()
  'budgets',                 // per-task and per-pulse ceilings on model calls, tokens, and wall clock
  'task-dependencies',       // dependsOn: a task waits for its producers and dead-letters if one fails (engine/pulse.js, task/reconcile.js)
]);

export default CAPABILITIES;
