/**
 * The data contract: the schema files under `schemas/` are exactly what the
 * engine validates against, and the dashboard's TypeScript unions name
 * exactly the statuses, wait reasons, priorities, and YAML fields the engine
 * uses. Text-level checks on purpose — the dashboard is not built here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_FILES, TASK_STATUSES, WAIT_REASONS, PRIORITIES, TASK_SCHEMA } from '../src/state/schema.js';
import { AUTONOMY_LEVELS } from '../src/policy/engine.js';
import { CAPABILITIES } from '../src/capabilities.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** The string literals of a `type X = "a" | "b"` union in a .ts file. */
function unionMembers(tsText, typeName) {
  const m = tsText.match(new RegExp(`export type ${typeName}\\s*=([^;]+);`));
  assert.ok(m, `type ${typeName} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test('schemas/*.schema.json are exactly the schemas the engine validates against (run scripts/export-schemas.mjs after a change)', () => {
  for (const [name, schema] of Object.entries(SCHEMA_FILES)) {
    const path = join(root, 'schemas', `${name}.schema.json`);
    assert.ok(existsSync(path), `schemas/${name}.schema.json is missing`);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(JSON.stringify(schema)), `schemas/${name}.schema.json is out of date`);
    assert.ok(Number.isInteger(schema.version), `${name}: a version`);
    assert.ok(typeof schema.description === 'string' && schema.description.length > 20, `${name}: a description`);
  }
});

test('the dashboard\'s TaskStatus, WaitReason, TaskPriority, and AutonomyLevel unions match the engine exactly', () => {
  const types = read('dashboard/lib/types.ts');
  assert.deepEqual(unionMembers(types, 'TaskStatus'), [...TASK_STATUSES]);
  assert.deepEqual(unionMembers(types, 'WaitReason'), [...WAIT_REASONS]);
  assert.deepEqual(unionMembers(types, 'TaskPriority'), [...PRIORITIES]);
  assert.deepEqual(unionMembers(types, 'AutonomyLevel'), [...AUTONOMY_LEVELS]);
  const meta = read('dashboard/lib/statusMeta.ts');
  for (const status of TASK_STATUSES) {
    const key = /^[a-z]+$/.test(status) ? status : `"${status}"`;
    assert.ok(new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*\\{`, 'm').test(meta), `STATUS_META lacks ${status}`);
  }
  for (const reason of WAIT_REASONS) {
    const key = /^[a-z]+$/.test(reason) ? reason : `"${reason}"`;
    assert.ok(new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*"`, 'm').test(meta), `WAIT_REASON_LABEL lacks ${reason}`);
  }
});

test('the dashboard\'s TaskRecord names every field of the engine\'s task schema', () => {
  const types = read('dashboard/lib/types.ts');
  const start = types.indexOf('export interface TaskRecord {');
  const block = types.slice(start, types.indexOf('\n}', start));
  const missing = Object.keys(TASK_SCHEMA.properties).filter((field) => !new RegExp(`^\\s+${field}\\??:`, 'm').test(block));
  // Internal bookkeeping the dashboard has no use for.
  const internal = new Set(['cancelRequested', 'pauseRequested', 'retriedBy', 'issueUpdatedAtSeen']);
  assert.deepEqual(missing.filter((f) => !internal.has(f)), []);
});

test('the dashboard\'s YAML builder and the engine\'s parser agree on the field names and the fence', () => {
  const builder = read('dashboard/lib/taskYaml.ts');
  const parser = read('src/lib/taskYaml.js');
  for (const field of ['title', 'priority', 'routingHint', 'filedVia', 'description', 'dependsOn', 'deadline', 'ttlHours', 'autonomy']) {
    assert.ok(builder.includes(`${field}:`), `builder lacks ${field}`);
    assert.ok(parser.includes(field), `parser lacks ${field}`);
  }
  assert.ok(builder.includes('"<!-- titan-task-v1"') && parser.includes('titan-task-v1'));
  assert.deepEqual(unionMembers(builder, 'Priority'), [...PRIORITIES]);
});

test('every declared capability has a scenario that requires it, and the control workflow lists every control action', () => {
  const scenarios = read('bench/scenarios.mjs');
  const required = new Set([...scenarios.matchAll(/requires:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
  const uncovered = CAPABILITIES.filter((c) => !required.has(c));
  // Capabilities every scenario exercises implicitly rather than by name.
  const implicit = new Set(['lifecycle-state-machine', 'event-log', 'failure-taxonomy', 'breakers', 'budgets']);
  assert.deepEqual(uncovered.filter((c) => !implicit.has(c)), []);
  const workflow = read('.github/workflows/titan-control.yml');
  for (const action of ['kill-switch', 'drain', 'safe-mode', 'autonomy', 'cancel', 'pause', 'resume', 'retry', 'priority', 'approve', 'deny']) {
    assert.ok(workflow.includes(`- ${action}`), `titan-control.yml lacks ${action}`);
  }
  assert.ok(workflow.includes('TITAN_CONTROL_ACTOR: ${{ github.actor }}'));
});
