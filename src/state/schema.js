/**
 * @file The versioned shape of every committed state file, and the
 * migrations between versions. `state/tasks.json` is the queue and the
 * record; everything the dashboard renders and everything the next pulse
 * decides comes from these files, so they are validated on every read and
 * every write (`state/store.js`).
 *
 * Versions:
 *   tasks.json v1 — the original flat task list (see AS_FOUND.md).
 *   tasks.json v2 — adds the lifecycle fields: attempts/maxAttempts, lease,
 *     waitReason/wakeAt, dependsOn/parentId, priority normalised, deadline,
 *     expiresAt, idempotencyKey, failure, history. Legacy statuses map 1:1.
 *
 * A migration never deletes a field it does not understand and never
 * changes a legacy status, so `migrateTasks(v2)` is a no-op and a v1 file
 * read by v2 code is exactly the v1 data plus defaults. Rolling back is
 * `git revert` of the state commit (documented in RUNBOOK.md); v1 code
 * ignores the extra fields.
 */

export const TASKS_SCHEMA_VERSION = 2;

export const TASK_STATUSES = Object.freeze([
  'pending', 'running', 'waiting', 'paused',
  'complete', 'failed', 'blocked', 'cancelled', 'expired', 'dead-lettered',
  'pr-open',
]);

export const WAIT_REASONS = Object.freeze(['backoff', 'dependency', 'approval', 'budget', 'quota', 'pulse-budget', 'provider']);
export const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

const iso = { type: 'string', format: 'date-time', nullable: true };

export const TASK_SCHEMA = {
  type: 'object',
  required: ['id', 'type', 'title', 'prompt', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    type: { enum: ['task', 'self-improve'] },
    issueNumber: { type: 'integer', nullable: true },
    issueUrl: { type: 'string', nullable: true, maxLength: 500 },
    author: { type: 'string', nullable: true, maxLength: 80 },
    title: { type: 'string', maxLength: 240 },
    prompt: { type: 'string', maxLength: 16000 },
    priority: { enum: [...PRIORITIES, null], nullable: true },
    routingHint: { enum: ['fast', 'cheap', 'careful', 'any', null], nullable: true },
    status: { enum: TASK_STATUSES },
    waitReason: { enum: [...WAIT_REASONS, null], nullable: true },
    wakeAt: iso,
    createdAt: { type: 'string', format: 'date-time' },
    claimedAt: iso,
    startedAt: iso,
    completedAt: iso,
    runId: { type: 'string', nullable: true },
    prNumber: { type: 'integer', nullable: true },
    prUrl: { type: 'string', nullable: true },
    error: { type: 'string', nullable: true, maxLength: 4000 },
    attempts: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 1 },
    lease: {
      type: 'object', nullable: true,
      required: ['owner', 'acquiredAt', 'expiresAt'],
      properties: { owner: { type: 'string' }, acquiredAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' } },
    },
    dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 32 },
    parentId: { type: 'string', nullable: true },
    deadline: iso,
    expiresAt: iso,
    idempotencyKey: { type: 'string', nullable: true, maxLength: 64 },
    failure: {
      type: 'object', nullable: true,
      properties: { class: { type: 'string' }, code: { type: 'string', nullable: true }, message: { type: 'string', maxLength: 2000 }, at: { type: 'string' } },
    },
    history: { type: 'array', maxItems: 40, items: { type: 'object', required: ['at', 'to'], properties: { at: { type: 'string' }, from: { type: 'string', nullable: true }, to: { type: 'string' }, reason: { type: 'string', nullable: true, maxLength: 300 } } } },
    autonomy: { enum: ['dry-run', 'propose', 'approval', 'autonomous', null], nullable: true },
  },
};

export const TASKS_FILE_SCHEMA = {
  type: 'object',
  required: ['version', 'tasks'],
  properties: {
    version: { type: 'integer', minimum: 1, maximum: TASKS_SCHEMA_VERSION },
    updatedAt: { type: 'string' },
    tasks: { type: 'array', items: TASK_SCHEMA },
  },
};

export const HEARTBEAT_SCHEMA = {
  type: 'object',
  required: ['version', 'lastPulseAt', 'lastPulseStatus'],
  properties: {
    version: { type: 'integer' },
    lastPulseAt: iso,
    lastPulseStatus: { enum: ['ok', 'error', null], nullable: true },
    lastPulseDurationMs: { type: 'number', nullable: true },
    consecutivePulseFailures: { type: 'integer', minimum: 0 },
    totalPulses: { type: 'integer', minimum: 0 },
    cadenceMinutes: { type: 'number' },
  },
};

export const CONTROL_SCHEMA = {
  type: 'object',
  required: ['version'],
  properties: {
    version: { type: 'integer' },
    killSwitch: { type: 'boolean' },
    drain: { type: 'boolean' },
    safeMode: { type: 'boolean' },
    autonomy: { enum: ['dry-run', 'propose', 'approval', 'autonomous'] },
    updatedAt: iso,
    updatedBy: { type: 'string', nullable: true },
    reason: { type: 'string', nullable: true, maxLength: 300 },
  },
};

export const EVENT_SCHEMA = {
  type: 'object',
  required: ['seq', 'ts', 'type', 'pulseId'],
  properties: {
    seq: { type: 'integer', minimum: 1 },
    ts: { type: 'string', format: 'date-time' },
    type: { type: 'string', pattern: '^[a-z]+(\\.[a-z-]+)+$' },
    pulseId: { type: 'string' },
    taskId: { type: 'string', nullable: true },
    runId: { type: 'string', nullable: true },
    attempt: { type: 'integer', nullable: true },
    stepId: { type: 'string', nullable: true },
    agent: { type: 'string', nullable: true },
    provider: { type: 'string', nullable: true },
    toolCallId: { type: 'string', nullable: true },
    parentId: { type: 'string', nullable: true },
    durationMs: { type: 'number', nullable: true },
    outcome: { type: 'string', nullable: true },
    failureClass: { type: 'string', nullable: true },
    calls: { type: 'integer', nullable: true },
    tokens: { type: 'integer', nullable: true },
  },
};

export const CHECKPOINT_SCHEMA = {
  type: 'object',
  required: ['version', 'taskId', 'runId', 'phase', 'updatedAt'],
  properties: {
    version: { type: 'integer' },
    taskId: { type: 'string' },
    runId: { type: 'string' },
    phase: { enum: ['planned', 'executing', 'executed', 'verifying', 'delivering', 'done'] },
    graph: { type: 'object', nullable: true },
    subtasks: { type: 'object' },
    sideEffects: { type: 'object' },
    verification: { type: 'object', nullable: true },
    remediations: { type: 'integer', minimum: 0 },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * Defaults every v2 task carries. Applied by the migration and by intake so
 * a task written by any code path has the same shape.
 * @param {{ maxAttempts?: number }} [opts]
 */
export function taskDefaults(opts = {}) {
  return {
    author: null,
    priority: 'normal',
    routingHint: null,
    waitReason: null,
    wakeAt: null,
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    runId: null,
    prNumber: null,
    prUrl: null,
    error: null,
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? 3,
    lease: null,
    dependsOn: [],
    parentId: null,
    deadline: null,
    expiresAt: null,
    idempotencyKey: null,
    failure: null,
    history: [],
    autonomy: null,
  };
}

/**
 * v1 → v2: add defaults, normalise a null/unknown priority to 'normal',
 * keep every legacy field and status untouched.
 * @param {object} file
 * @param {{ maxAttempts?: number }} [opts]
 * @returns {{ file: object, migrated: boolean, from: number }}
 */
export function migrateTasks(file, opts = {}) {
  const from = Number.isInteger(file?.version) ? file.version : 1;
  if (from >= TASKS_SCHEMA_VERSION) return { file, migrated: false, from };
  const defaults = taskDefaults(opts);
  const tasks = (Array.isArray(file?.tasks) ? file.tasks : []).map((t) => {
    const out = { ...defaults, ...t };
    if (!PRIORITIES.includes(out.priority)) out.priority = 'normal';
    if (!Array.isArray(out.dependsOn)) out.dependsOn = [];
    if (!Array.isArray(out.history)) out.history = [];
    if (!Number.isInteger(out.attempts)) out.attempts = 0;
    if (!Number.isInteger(out.maxAttempts)) out.maxAttempts = defaults.maxAttempts;
    return out;
  });
  return { file: { ...file, version: TASKS_SCHEMA_VERSION, tasks }, migrated: true, from };
}

export default {
  TASKS_SCHEMA_VERSION, TASK_STATUSES, WAIT_REASONS, PRIORITIES,
  TASK_SCHEMA, TASKS_FILE_SCHEMA, HEARTBEAT_SCHEMA, CONTROL_SCHEMA, EVENT_SCHEMA, CHECKPOINT_SCHEMA,
  taskDefaults, migrateTasks,
};
