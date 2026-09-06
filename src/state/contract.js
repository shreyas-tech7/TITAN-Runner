/**
 * @file Hand-rolled validator for the shared contract (`docs/CONTRACT.md`)
 * this repo publishes to `state/runs/*.json`, and the twin private
 * `shreyas-tech7/TITAN` repo is being built against in parallel.
 *
 * No zod/ajv — see `docs/DECISIONS.md` D-2 for why: this repo has shipped
 * zero runtime dependencies by deliberate prior design, and a public,
 * unattended, auto-committing pipeline is exactly the wrong place to take
 * its first one just for schema validation. This module covers the exact
 * fields `docs/CONTRACT.md` defines — nothing more, nothing framework-y.
 */

/** The contract version this repo's run records are written against.
 *  Bump the minor/patch freely for additive changes; bump the major only
 *  for a breaking change to the envelope shape, and update
 *  `SUPPORTED_MAJOR` below in the same change. */
export const CONTRACT_VERSION = '1.0.0';

/** The only major version this reader accepts. A run record whose
 *  `contractVersion` carries a different major is REJECTED loudly (task
 *  brief, Track C: "reject unknown majors loudly") rather than
 *  best-effort-parsed — an envelope shape change big enough to bump the
 *  major is exactly the kind of change that silently-tolerant parsing gets
 *  wrong in some field nobody thought to check. */
export const SUPPORTED_MAJOR = 1;

export const RUN_STATUSES = Object.freeze([
  'queued', 'planning', 'running', 'review', 'blocked', 'done', 'failed', 'cancelled',
]);

export const REVIEWER_VERDICTS = Object.freeze(['allow', 'block', 'needs-human']);

export const PROVIDER_IDS = Object.freeze([
  'groq', 'together', 'huggingface', 'openrouter', 'gemini', 'freebuff', 'opencode', 'hermes',
]);

/** @param {string} v @returns {number|null} The major version number, or null if unparsable. */
export function majorOf(v) {
  const m = typeof v === 'string' ? v.match(/^(\d+)\.\d+\.\d+$/) : null;
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * @param {unknown} value
 * @param {string} path Dotted path, for error messages.
 * @param {string[]} errors Mutated in place.
 * @returns {value is string}
 */
function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path}: expected a non-empty string, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

function requireEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${path}: expected one of [${allowed.join(', ')}], got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

function requireBoolean(value, path, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${path}: expected a boolean, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

/**
 * Validate one run envelope against the contract. Reads only — never
 * mutates, never throws; every failure is collected and returned.
 * @param {unknown} envelope
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRunEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, errors: ['envelope must be an object'] };
  }
  /** @type {any} */
  const e = envelope;

  if (!requireString(e.contractVersion, 'contractVersion', errors)) {
    // Nothing else is safe to check against an unknown/missing contract
    // version — everything downstream assumes this exact shape.
    return { ok: false, errors };
  }
  const major = majorOf(e.contractVersion);
  if (major === null) {
    errors.push(`contractVersion: "${e.contractVersion}" is not a valid semver string`);
    return { ok: false, errors };
  }
  if (major !== SUPPORTED_MAJOR) {
    errors.push(
      `contractVersion: major version ${major} is not supported by this reader ` +
        `(supports major ${SUPPORTED_MAJOR} only) — refusing to guess at an unknown envelope shape`,
    );
    return { ok: false, errors };
  }

  requireString(e.runId, 'runId', errors);
  if (e.taskId !== null && e.taskId !== undefined) requireString(String(e.taskId), 'taskId', errors);
  requireString(e.title, 'title', errors);
  requireEnum(e.status, RUN_STATUSES, 'status', errors);
  requireString(e.createdAt, 'createdAt', errors);
  requireString(e.updatedAt, 'updatedAt', errors);
  requireBoolean(e.redacted, 'redacted', errors);
  if (e.redacted === false) {
    errors.push('redacted: must be true for every envelope in this repo (task brief, Track A #1)');
  }

  if (requireArray(e.subtasks, 'subtasks', errors)) {
    e.subtasks.forEach((s, i) => {
      const p = `subtasks[${i}]`;
      if (!s || typeof s !== 'object') {
        errors.push(`${p}: expected an object`);
        return;
      }
      requireString(s.id, `${p}.id`, errors);
      requireString(s.title, `${p}.title`, errors);
      if (typeof s.costUsd !== 'number' || s.costUsd !== 0) {
        errors.push(`${p}.costUsd: must always be 0 in this repo, got ${JSON.stringify(s.costUsd)}`);
      }
      requireArray(s.artifacts, `${p}.artifacts`, errors);
    });
  }

  if (e.reviewer !== null && e.reviewer !== undefined) {
    const r = e.reviewer;
    if (!r || typeof r !== 'object') {
      errors.push('reviewer: expected an object or null');
    } else {
      requireEnum(r.verdict, REVIEWER_VERDICTS, 'reviewer.verdict', errors);
      requireArray(r.reasons, 'reviewer.reasons', errors);
      requireArray(r.ruleIds, 'reviewer.ruleIds', errors);
    }
  }

  if (e.metrics !== null && e.metrics !== undefined) {
    const m = e.metrics;
    if (!m || typeof m !== 'object') {
      errors.push('metrics: expected an object or null');
    } else {
      for (const field of ['durationMs', 'providerCalls', 'retries', 'failoverHops']) {
        if (typeof m[field] !== 'number' || m[field] < 0) {
          errors.push(`metrics.${field}: expected a non-negative number, got ${JSON.stringify(m[field])}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export default { validateRunEnvelope, CONTRACT_VERSION, SUPPORTED_MAJOR, RUN_STATUSES, REVIEWER_VERDICTS, PROVIDER_IDS, majorOf };
