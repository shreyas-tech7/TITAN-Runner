/**
 * @file Strict schemas for every file under `state/` (RT7).
 *
 * The state folder is public. A file that holds a key that nobody planned could leak data. So each file has a
 * schema that forbids extra fields: an object lists every key that it may hold, and `additionalProperties` is false.
 * `scripts/check-state.mjs` checks every file against these schemas in CI. A file with no schema fails the check,
 * so a new kind of state file needs a schema in the same pull request.
 *
 * Two kinds of loose spots stay, and each one is bounded:
 *   - `SMALL` is a small piece of JSON: scalars, short arrays, and objects of scalars, three levels deep at most.
 *     It is used where the shape depends on the data (an event field, an error detail).
 *   - A `map` is an object whose keys are data (a provider id, a task status) and whose values have one schema.
 *
 * To add a field: add the key to the schema here, in the same change that writes it.
 */
import { CHECKPOINT_SCHEMA, CONTROL_SCHEMA, QUOTA_SCHEMA, TASKS_FILE_SCHEMA } from './schema.js';

// ---------------------------------------------------------------------
// A small DSL
// ---------------------------------------------------------------------

const STR = (max = 2000) => ({ type: 'string', maxLength: max });
const NSTR = (max = 2000) => ({ type: 'string', maxLength: max, nullable: true });
const NUM = { type: 'number' };
const NNUM = { type: 'number', nullable: true };
const INT = { type: 'integer' };
const NINT = { type: 'integer', nullable: true };
const BOOL = { type: 'boolean' };
const TS = { type: 'string', format: 'date-time' };
const NTS = { type: 'string', format: 'date-time', nullable: true };
const ANYSTR = (max = 500) => ({ type: 'array', maxItems: 500, items: { type: 'string', maxLength: max } });

const SCALAR = { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };
const SMALL_OBJECT = { type: 'object', additionalProperties: SCALAR };
const SMALL_ARRAY = { type: 'array', maxItems: 500, items: { anyOf: [SCALAR, SMALL_OBJECT] } };
/** A small piece of JSON, at most three levels deep. */
export const SMALL = {
  anyOf: [
    SCALAR,
    SMALL_ARRAY,
    { type: 'object', additionalProperties: { anyOf: [SCALAR, SMALL_ARRAY, { type: 'object', additionalProperties: { anyOf: [SCALAR, SMALL_ARRAY] } }] } },
  ],
};

/** An object that lists every key it may hold. A key in `optional` may be missing. */
export const obj = (properties, optional = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
});
/** An object whose keys are data and whose values all match one schema. */
export const map = (value) => ({ type: 'object', additionalProperties: value });
const arr = (items, max = 1000) => ({ type: 'array', maxItems: max, items });

/**
 * Clone a schema and forbid extra keys on every object that lists `properties`.
 * An object without `properties` is left open on purpose, so name it a `map` or `SMALL` when you write it.
 */
export function strictify(schema) {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, strictify(s)]));
    else if (k === 'items' || k === 'additionalProperties') out[k] = strictify(v);
    else if (k === 'anyOf') out[k] = v.map(strictify);
    else out[k] = v;
  }
  if (out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

// ---------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------

const TASKS = (() => {
  const s = strictify(TASKS_FILE_SCHEMA);
  s.properties.tasks.items.properties.approvals = { type: 'object', nullable: true, additionalProperties: SMALL };
  return s;
})();

const HEARTBEAT = obj({
  version: INT, lastPulseAt: TS, lastPulseStatus: STR(40), lastPulseDurationMs: NUM, lastPulseTasksClaimed: INT,
  lastPulseTasksCompleted: INT, lastPulseTasksFailed: INT, lastPulseError: NSTR(2000), consecutivePulseFailures: INT,
  totalPulses: INT, cadenceMinutes: NUM, pulseId: STR(120), modelCalls: INT,
  budget: obj({ budgetMs: NUM, elapsedMs: NUM, remainingMs: NUM, draining: BOOL }),
}, ['pulseId', 'modelCalls', 'budget']);

const CONTROL = strictify(CONTROL_SCHEMA);

const QUOTA_WINDOW = obj({ start: STR(40), count: INT });
const QUOTA = (() => {
  const s = strictify(QUOTA_SCHEMA);
  s.properties.providers = map(obj({ minute: QUOTA_WINDOW, day: QUOTA_WINDOW, tokens: NUM, last429At: NSTR(40) }, ['tokens', 'last429At']));
  return s;
})();

const PROVIDER_RECORD = obj({
  id: STR(60), configured: BOOL, status: STR(40), lastCheckedAt: NSTR(40), lastSuccessAt: NSTR(40), latencyMs: NNUM, p50LatencyMs: NNUM,
  samples: INT, errorRate: NUM, consecutiveFailures: INT, cooldownUntil: NSTR(40), lastError: NSTR(2000), model: NSTR(200),
  discoveredModels: ANYSTR(200), modelsDiscoveredAt: NSTR(40), note: NSTR(2000), lastFailureClass: NSTR(80),
}, ['lastFailureClass', 'note']);
const PROVIDERS = obj({ version: INT, updatedAt: STR(40), providers: map(PROVIDER_RECORD) });

const AGENT_RECORD = obj({
  modelId: STR(200), pool: STR(80), strengths: ANYSTR(80), weaknesses: ANYSTR(80), latencyClass: STR(40), contextWindow: NUM,
  source: STR(200), probedAt: NSTR(40), observed: map(obj({ runs: INT, successRate: NUM, avgMs: NUM })),
  // RO3: scores that the weekly golden task eval measured. A measured score beats an assumed strength.
  measured: map(obj({ score: NUM, tasksRun: INT, runAt: STR(40), evalVersion: STR(40) })),
}, ['measured']);
const AGENTS = map(AGENT_RECORD);

const RESEARCH = obj({
  version: INT, lastAttemptAt: NSTR(40), lastStatus: STR(60), lastReason: NSTR(500), lastDigestDate: NSTR(20), lastDigestFile: NSTR(200),
  provider: NSTR(80), model: NSTR(200), topicIds: ANYSTR(80), preview: NSTR(2000), lastDetail: NSTR(2000),
}, ['lastDigestDate', 'lastDigestFile', 'provider', 'model', 'topicIds', 'preview', 'lastDetail']);

const PULSE_HISTORY = obj({
  version: INT,
  pulses: arr(obj({ at: STR(40), durationMs: NUM, status: STR(40), tasksClaimed: INT, tasksCompleted: INT, tasksFailed: INT, modelCalls: INT }, ['modelCalls']), 500),
});

const VIEW_HEAD = { version: INT, updatedAt: STR(40) };
const VIEWS = {
  analytics: obj({
    ...VIEW_HEAD,
    window: obj({ events: INT, from: NSTR(40), to: NSTR(40), archived: obj({ days: INT, events: INT, calls: INT }) }),
    tasks: obj({ finished: INT, succeeded: INT, successRate: NNUM, byOutcome: map(INT), deadLetteredByClass: map(INT) }),
    reliability: obj({ retriesByClass: map(INT), parks: INT, loops: INT, remediations: INT }),
    verification: obj({ runs: INT, passRate: NNUM, unjudged: INT }),
    tools: obj({ calls: INT, denied: INT }),
    policy: obj({ approvalsRequested: INT, denials: INT }),
    cost: obj({ modelCalls: INT, upstreamCalls: INT, tokens: INT, callsPerCompletedTask: NNUM, callsPerPulse: NNUM }),
    pulses: obj({ count: INT, p50Ms: NNUM, p95Ms: NNUM, maxMs: NNUM }),
  }),
  providers: obj({
    ...VIEW_HEAD,
    providers: map(obj({
      breaker: STR(40), until: NSTR(40), reason: NSTR(500), explain: NSTR(1000), status: STR(40), consecutiveFailures: INT,
      lastFailureClass: NSTR(80), quota: { ...obj({ usedMinute: NUM, usedDay: NUM, dayLeft: NNUM, perDay: NNUM }), nullable: true },
    })),
  }),
  queue: obj({
    ...VIEW_HEAD, total: INT, byStatus: map(INT), byWaitReason: map(INT), active: INT, running: arr(SMALL, 200), nextWake: SMALL,
    oldestPending: SMALL, approvalsPending: arr(SMALL, 200), deadLettered: arr(SMALL, 200),
  }),
  research: obj({
    ...VIEW_HEAD, lastAttemptAt: NSTR(40), lastStatus: STR(60), lastReason: NSTR(500),
    digest: obj({ date: STR(20), file: STR(200), provider: STR(80), model: STR(200), topics: ANYSTR(80), preview: STR(2000) }, []),
  }, ['digest']),
  safety: obj({
    ...VIEW_HEAD,
    rules: obj({ source: STR(200), default: STR(60), autoApprove: ANYSTR(80), alwaysAsk: ANYSTR(80), hardFloor: ANYSTR(80), warnings: ANYSTR(500) }),
    approvals: obj({ total: INT, approved: INT, denied: INT, byCategory: map(SMALL), recent: arr(SMALL, 200) }),
  }),
};

const RUN_TASK = obj({
  id: STR(120), title: STR(500), aspect: STR(80), state: STR(40), assignment: SMALL, attempts: arr(map(SMALL), 100),
  outputPreview: NSTR(4000), error: SMALL, dependsOn: ANYSTR(80), prompt: STR(20000), role: STR(80), files: arr(SMALL, 200),
}, ['error', 'dependsOn', 'prompt', 'role', 'files', 'outputPreview']);
const RUN = obj({
  runId: STR(120), taskId: STR(120), taskTitle: STR(500), issueUrl: NSTR(500), createdAt: TS, durationMs: NUM, state: STR(40),
  actionsRunUrl: NSTR(500), sharedContext: STR(20000), tasks: arr(RUN_TASK, 100), files: arr(SMALL, 500), markdownSummary: STR(60000),
}, ['issueUrl', 'actionsRunUrl']);

const EVENT = {
  type: 'object',
  required: ['seq', 'ts', 'type', 'pulseId'],
  additionalProperties: SMALL,
  properties: {
    seq: INT, ts: TS, type: STR(80), pulseId: STR(120), taskId: NSTR(120), runId: NSTR(120), attempt: NINT, stepId: NSTR(120),
    agent: NSTR(120), provider: NSTR(80), toolCallId: NSTR(200), parentId: NSTR(120), durationMs: NNUM, outcome: NSTR(120),
    failureClass: NSTR(80), calls: NINT, tokens: NINT, audit: BOOL,
  },
};
const EVENT_ARCHIVE = obj({
  date: STR(20), events: INT, byType: map(INT), byOutcome: map(INT), byFailureClass: map(INT), calls: INT, tokens: INT,
}, ['calls', 'tokens', 'byFailureClass', 'byOutcome']);
const REVIEW = obj({
  ts: TS, toolId: STR(120), classification: STR(40), verdict: STR(40), layer: INT, matchedRules: ANYSTR(80), failMode: NSTR(40),
  reason: NSTR(2000), suggestion: NSTR(2000),
});
const APPROVAL_LOG = obj({ v: INT, at: STR(40), taskId: STR(120), issueNumber: NINT, key: STR(200), category: STR(80), decision: STR(40), by: STR(120), via: STR(40) });
const LEASE = obj({ owner: STR(200), acquiredAt: TS, expiresAt: TS });
const ARCHIVED_TASK = TASKS.properties.tasks.items;

// RO1 to RO6: the public mirrors, the lessons, and the maintenance record.
const OPS_META = { contract: STR(10), generated_at: STR(40) };
const OPS = {
  health: obj({
    ...OPS_META,
    providers: map(map(obj({ status: STR(30), latency_ms: NNUM, checked_at: STR(40), error_class: NSTR(80) }))),
  }),
  quota: obj({
    ...OPS_META,
    providers: map(map(obj({
      limit_day: NNUM, used_day: NUM, limit_month: NNUM, used_month: NUM, remaining_pct: NNUM, resets_at: NSTR(40), exhausted: BOOL,
      limit_source: NSTR(500), limit_confidence: STR(20),
    }))),
  }),
  eval: obj({
    ...OPS_META,
    eval_version: STR(40),
    models: map(map(obj({ score: NUM, tasks_run: INT, run_at: STR(40), eval_version: STR(40) }))),
  }, ['eval_version']),
  hosts: obj({
    ...OPS_META,
    hosts: map(obj({ status: STR(20), last_check: NSTR(40), uptime_24h: NNUM, uptime_7d: NNUM, uptime_30d: NNUM, last_pulse_at: NSTR(40) }, ['last_pulse_at'])),
  }),
};
const LESSON = obj({
  id: STR(80), signature: STR(200), first_seen: STR(40), last_seen: STR(40), count: INT, task_type: NSTR(80), what_failed: STR(2000),
  likely_cause: STR(2000), suggested_fix: STR(2000), source: STR(20), run_ids: ANYSTR(100),
}, ['task_type', 'run_ids']);
const MAINTENANCE = obj({
  version: INT, lastRunAt: STR(40), archived: map(INT), stateFiles: INT, stateBytes: INT, validated: BOOL, note: NSTR(500),
}, ['note']);

/**
 * How to find the schema of a state file. The path is relative to `state/` and uses `/`.
 * `kind`: `json` (one value), `jsonl` (one value per line), `gz-jsonl` (the same, compressed), or `text` (no schema).
 * @type {Array<{ id: string, kind: 'json'|'jsonl'|'gz-jsonl'|'text', match: RegExp, schema: object|null }>}
 */
export const STATE_FILES = [
  { id: 'tasks', kind: 'json', match: /^(backup\/)?tasks\.json$/, schema: TASKS },
  { id: 'control', kind: 'json', match: /^(backup\/)?control\.json$/, schema: CONTROL },
  { id: 'heartbeat', kind: 'json', match: /^heartbeat\.json$/, schema: HEARTBEAT },
  { id: 'quota', kind: 'json', match: /^quota\.json$/, schema: QUOTA },
  { id: 'providers', kind: 'json', match: /^providers\.json$/, schema: PROVIDERS },
  { id: 'agents', kind: 'json', match: /^agents\.json$/, schema: AGENTS },
  { id: 'research', kind: 'json', match: /^research\.json$/, schema: RESEARCH },
  { id: 'pulse-history', kind: 'json', match: /^pulse-history\.json$/, schema: PULSE_HISTORY },
  { id: 'maintenance', kind: 'json', match: /^maintenance\.json$/, schema: MAINTENANCE },
  ...Object.entries(VIEWS).map(([name, schema]) => ({ id: `view-${name}`, kind: /** @type {const} */ ('json'), match: new RegExp(`^views/${name}\\.json$`), schema })),
  { id: 'run', kind: 'json', match: /^runs\/[A-Za-z0-9._-]+\.json$/, schema: RUN },
  { id: 'checkpoint', kind: 'json', match: /^checkpoints\/[A-Za-z0-9._-]+\.json$/, schema: strictify(CHECKPOINT_SCHEMA) },
  { id: 'lease', kind: 'json', match: /^leases\/[A-Za-z0-9._-]+\.json$/, schema: LEASE },
  { id: 'event', kind: 'jsonl', match: /^events\/\d{4}-\d{2}-\d{2}\.jsonl$/, schema: EVENT },
  { id: 'event-archive', kind: 'json', match: /^events\/archive\/\d{4}-\d{2}-\d{2}\.json$/, schema: EVENT_ARCHIVE },
  { id: 'review', kind: 'jsonl', match: /^reviews\/[A-Za-z0-9._-]+\.jsonl$/, schema: REVIEW },
  { id: 'approval-log', kind: 'jsonl', match: /^approval-log\.jsonl$/, schema: APPROVAL_LOG },
  { id: 'archived-task', kind: 'jsonl', match: /^archive\/tasks-\d{4}-\d{2}\.jsonl$/, schema: ARCHIVED_TASK },
  { id: 'archive-tasks', kind: 'gz-jsonl', match: /^archive\/tasks-\d{4}-\d{2}\.jsonl\.gz$/, schema: ARCHIVED_TASK },
  { id: 'archive-runs', kind: 'gz-jsonl', match: /^archive\/runs-\d{4}-\d{2}\.jsonl\.gz$/, schema: RUN },
  { id: 'archive-events', kind: 'gz-jsonl', match: /^archive\/events-summary-\d{4}-\d{2}\.jsonl\.gz$/, schema: EVENT_ARCHIVE },
  { id: 'archive-reviews', kind: 'gz-jsonl', match: /^archive\/reviews-\d{4}-\d{2}\.jsonl\.gz$/, schema: REVIEW },
  { id: 'archive-digests', kind: 'gz-jsonl', match: /^archive\/digests-\d{4}-\d{2}\.jsonl\.gz$/, schema: obj({ name: STR(200), text: STR(60000) }) },
  { id: 'ops-health', kind: 'json', match: /^ops\/health\.json$/, schema: OPS.health },
  { id: 'ops-quota', kind: 'json', match: /^ops\/quota\.json$/, schema: OPS.quota },
  { id: 'ops-eval', kind: 'json', match: /^ops\/eval\.json$/, schema: OPS.eval },
  { id: 'ops-hosts', kind: 'json', match: /^ops\/hosts\.json$/, schema: OPS.hosts },
  { id: 'lessons', kind: 'jsonl', match: /^lessons\.jsonl$/, schema: LESSON },
  { id: 'digest', kind: 'text', match: /^digests\/[A-Za-z0-9._-]+\.md$/, schema: null },
  { id: 'keep', kind: 'text', match: /(^|\/)\.gitkeep$/, schema: null },
];

/** @param {string} relPath @returns {(typeof STATE_FILES)[number] | null} */
export function schemaFor(relPath) {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return STATE_FILES.find((f) => f.match.test(p)) ?? null;
}

/**
 * Meta check: every object schema in the registry either lists its keys and forbids extras, or is a `map`, or is `SMALL`.
 * Returns the paths of objects that list `properties` but allow extra keys.
 */
export function findLooseObjects(schema, path = '$', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.properties && schema.additionalProperties !== false && !(schema.additionalProperties && typeof schema.additionalProperties === 'object')) out.push(path);
  for (const [k, v] of Object.entries(schema.properties ?? {})) findLooseObjects(v, `${path}.${k}`, out);
  if (schema.items) findLooseObjects(schema.items, `${path}[]`, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') findLooseObjects(schema.additionalProperties, `${path}.*`, out);
  for (const s of schema.anyOf ?? []) findLooseObjects(s, path, out);
  return out;
}

export default { STATE_FILES, schemaFor, strictify, obj, map, SMALL, findLooseObjects };
