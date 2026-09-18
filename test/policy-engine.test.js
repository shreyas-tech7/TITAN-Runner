import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, effectiveAutonomy, approvalKeyFor, AUTONOMY_LEVELS } from '../src/policy/engine.js';

const control = (over = {}) => ({ killSwitch: false, safeMode: false, autonomy: 'autonomous', ...over });
const tool = (effect, toolId = 'x_tool', args = { a: 1 }) => ({ kind: 'tool', toolId, effect, args });

test('the effective autonomy is the stricter of the control file and the task', () => {
  assert.equal(effectiveAutonomy(control({ autonomy: 'autonomous' }), { autonomy: 'propose' }), 'propose');
  assert.equal(effectiveAutonomy(control({ autonomy: 'dry-run' }), { autonomy: 'autonomous' }), 'dry-run');
  assert.equal(effectiveAutonomy(control({ autonomy: 'approval' }), {}), 'approval');
  assert.equal(effectiveAutonomy(control({ autonomy: 'nonsense' }), { autonomy: null }), 'autonomous');
});

test('the decision matrix: reads always pass; each level gates writes and external effects as documented', () => {
  const matrix = {
    'dry-run': { read: 'allow', local_write: 'deny', external: 'deny' },
    propose: { read: 'allow', local_write: 'allow', external: 'approve' },
    approval: { read: 'allow', local_write: 'approve', external: 'approve' },
    autonomous: { read: 'allow', local_write: 'allow', external: 'allow' },
  };
  for (const level of AUTONOMY_LEVELS) {
    for (const [effect, expected] of Object.entries(matrix[level])) {
      const d = decide({ action: tool(effect), control: control({ autonomy: level }) });
      assert.equal(d.decision, expected, `${level}/${effect}: ${d.reason}`);
      assert.equal(d.autonomy, level);
    }
  }
});

test('safe mode forbids external effects at every level but leaves local writes to the level', () => {
  assert.equal(decide({ action: tool('external'), control: control({ safeMode: true }) }).decision, 'deny');
  assert.equal(decide({ action: tool('local_write'), control: control({ safeMode: true }) }).decision, 'allow');
  assert.equal(decide({ action: tool('external'), control: control({ safeMode: true, autonomy: 'propose' }) }).decision, 'deny');
  assert.equal(decide({ action: tool('read'), control: control({ safeMode: true, autonomy: 'dry-run' }) }).decision, 'allow');
});

test('a recorded approval turns "approve" into "allow" for that key only; a denial wins over everything; "all" covers every key', () => {
  const action = tool('external');
  const key = approvalKeyFor(action);
  assert.match(key, /^tool:x_tool:[0-9a-f]{8}$/);
  const approved = decide({ action, control: control({ autonomy: 'approval' }), task: { approvals: { [key]: { decision: 'approved', by: 'owner' } } } });
  assert.deepEqual([approved.decision, approved.reason], ['allow', 'approved by owner']);
  const other = decide({ action: tool('external', 'x_tool', { a: 2 }), control: control({ autonomy: 'approval' }), task: { approvals: { [key]: { decision: 'approved', by: 'owner' } } } });
  assert.equal(other.decision, 'approve', 'different args, different key');
  const denied = decide({ action, control: control(), task: { approvals: { [key]: { decision: 'denied', by: 'owner' } } } });
  assert.equal(denied.decision, 'deny');
  const all = decide({ action, control: control({ autonomy: 'approval' }), task: { approvals: { all: { decision: 'approved', by: 'owner' } } } });
  assert.equal(all.decision, 'allow');
  const dryRunApproved = decide({ action, control: control({ autonomy: 'dry-run' }), task: { approvals: { all: { decision: 'approved', by: 'owner' } } } });
  assert.equal(dryRunApproved.decision, 'deny', 'an approval cannot lift dry-run');
});

test('the kill switch denies everything, and delivery keys are per run', () => {
  assert.equal(decide({ action: tool('read'), control: control({ killSwitch: true }) }).decision, 'deny');
  assert.equal(approvalKeyFor({ kind: 'deliver', effect: 'external', runId: 'r1' }), 'deliver:r1');
  assert.equal(approvalKeyFor({ kind: 'self-improve', effect: 'external', runId: 'r2' }), 'self-improve:r2');
  const d = decide({ action: { kind: 'deliver', effect: 'external', runId: 'r1' }, control: control({ autonomy: 'propose' }) });
  assert.equal(d.decision, 'approve');
  assert.match(d.reason, /\/titan approve deliver:r1/);
});
