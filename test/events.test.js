import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, readEventsDir } from '../src/observability/events.js';
import { check } from '../src/lib/validate.js';
import { EVENT_SCHEMA } from '../src/state/schema.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-events-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('events are appended as one JSON line each, validate against the schema, and seq continues across processes', () => {
  const { dir, cleanup } = fresh();
  try {
    const now = () => new Date('2026-01-05T10:00:00.000Z');
    const a = new EventLog({ dir, pulseId: 'p1', now });
    a.append('pulse.started', { budgetMs: 1 });
    a.append('task.transition', { taskId: 'issue-1', from: 'pending', to: 'running' });
    const b = new EventLog({ dir, pulseId: 'p2', now });
    b.append('pulse.started', {});
    const all = readEventsDir(dir);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(all.map((e) => e.pulseId), ['p1', 'p1', 'p2']);
    for (const e of all) assert.ok(check(e, EVENT_SCHEMA).ok, JSON.stringify(e));
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    cleanup();
  }
});

test('every event is redacted before it is written: a canary key in any field never reaches disk', () => {
  const { dir, cleanup } = fresh();
  try {
    const log = new EventLog({ dir, pulseId: 'p', now: () => new Date('2026-01-05T10:00:00.000Z') });
    const canary = 'gsk_' + 'canaryCANARYcanary0123456789';
    log.append('step.finished', { taskId: 't', error: `upstream said: ${canary}`, nested: { deeper: [`Bearer ${canary}`] } });
    const text = readFileSync(join(dir, '2026-01-05.jsonl'), 'utf8');
    assert.ok(!text.includes(canary));
    assert.ok(text.includes('[REDACTED]'));
  } finally {
    cleanup();
  }
});

test('a torn last line (killed process) is skipped, not fatal, and seq resumes from the last intact line', () => {
  const { dir, cleanup } = fresh();
  try {
    const now = () => new Date('2026-01-05T10:00:00.000Z');
    const a = new EventLog({ dir, pulseId: 'p1', now });
    a.append('x.y', {});
    a.append('x.y', {});
    const file = join(dir, '2026-01-05.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"seq":3,"ts":"2026-01-05T10:00:00.000Z","type":"x.y","pul`);
    const b = new EventLog({ dir, pulseId: 'p2', now });
    b.append('x.z', {});
    const all = readEventsDir(dir);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
    assert.equal(all.at(-1).type, 'x.z');
  } finally {
    cleanup();
  }
});

test('compact() rolls files past the retention window into count summaries and deletes them', () => {
  const { dir, cleanup } = fresh();
  try {
    const old = new EventLog({ dir, pulseId: 'p0', now: () => new Date('2025-12-01T10:00:00.000Z') });
    old.append('step.finished', { outcome: 'complete', calls: 2, tokens: 30 });
    old.append('step.finished', { outcome: 'failed', failureClass: 'timeout', calls: 3 });
    const recent = new EventLog({ dir, pulseId: 'p1', now: () => new Date('2026-01-05T10:00:00.000Z'), retentionDays: 14 });
    recent.append('pulse.started', {});
    const result = recent.compact();
    assert.equal(result.compacted, 1);
    assert.ok(!existsSync(join(dir, '2025-12-01.jsonl')));
    const summary = JSON.parse(readFileSync(join(dir, 'archive', '2025-12-01.json'), 'utf8'));
    assert.equal(summary.events, 2);
    assert.equal(summary.byOutcome.failed, 1);
    assert.equal(summary.byFailureClass.timeout, 1);
    assert.equal(summary.calls, 5);
    assert.ok(existsSync(join(dir, '2026-01-05.jsonl')));
  } finally {
    cleanup();
  }
});
