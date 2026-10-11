import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMaintenance } from '../src/state/maintenance.js';
import { readArchive, rollOldFiles, writeMonthlyArchive } from '../src/state/archive.js';
import { checkStateDir } from '../scripts/check-state.mjs';

function stateWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'titan-maint-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const NOW = new Date('2026-10-11T12:00:00Z');
const run = (id, createdAt) => ({ runId: id, taskId: 't', taskTitle: 'x', createdAt, durationMs: 1, state: 'complete', sharedContext: '', tasks: [], files: [], markdownSummary: '' });
const summary = (date) => ({ date, events: 3, byType: { 'pulse.started': 1 }, byOutcome: {}, byFailureClass: {}, calls: 0, tokens: 0 });
const review = (ts, toolId = 'orchestrate-task') => ({ ts, toolId, classification: 'caution', verdict: 'allow', layer: 2, matchedRules: [], failMode: null, reason: null, suggestion: null });

test('monthly archives are deterministic, merge by id, and add no commit on a repeat run', () => {
  const { dir, cleanup } = stateWith({});
  try {
    const opts = { archiveDir: join(dir, 'archive'), name: 'runs', month: '2026-05', idOf: (r) => r.runId };
    const first = writeMonthlyArchive({ ...opts, records: [run('b', '2026-05-02T00:00:00Z'), run('a', '2026-05-01T00:00:00Z')] });
    assert.deepEqual([first.total, first.added, first.changed], [2, 2, true]);
    assert.deepEqual(readArchive(first.path).map((r) => r.runId), ['a', 'b'], 'sorted by id');
    const bytes = readFileSync(first.path);
    const again = writeMonthlyArchive({ ...opts, records: [run('a', '2026-05-01T00:00:00Z')] });
    assert.deepEqual([again.total, again.added, again.changed], [2, 0, false], 'the same record is not added twice and the file does not change');
    assert.ok(Buffer.compare(bytes, readFileSync(first.path)) === 0);
  } finally {
    cleanup();
  }
});

test('the daily maintenance rolls old files into monthly archives, keeps recent files, writes maintenance.json, and the tree stays valid', () => {
  const files = {
    'runs/old-1.json': run('old-1', '2026-06-01T00:00:00.000Z'),
    'runs/old-2.json': run('old-2', '2026-06-20T00:00:00.000Z'),
    'runs/new-1.json': run('new-1', '2026-10-10T00:00:00.000Z'),
    'events/archive/2026-05-01.json': summary('2026-05-01'),
    'events/archive/2026-05-02.json': summary('2026-05-02'),
    'events/archive/2026-10-01.json': summary('2026-10-01'),
    'digests/2026-05-01-research.md': '# old digest\n',
    'digests/2026-10-10-research.md': '# new digest\n',
    'reviews/reviews-2026-05-01.jsonl': `${JSON.stringify(review('2026-05-01T10:00:00.000Z'))}\n${JSON.stringify(review('2026-05-01T11:00:00.000Z'))}\n`,
    'reviews/reviews-2026-10-10.jsonl': `${JSON.stringify(review('2026-10-10T10:00:00.000Z'))}\n`,
  };
  const { dir, cleanup } = stateWith(files);
  try {
    const { maintenance, problems } = runMaintenance({ stateDir: dir, now: NOW });
    assert.deepEqual(problems, []);
    // The three runs are under the "newest 10 stay" rule, so none moves. Only the file counts set the rule.
    assert.deepEqual(maintenance.archived, { runs: 0, eventSummaries: 2, digests: 1, reviews: 2 });
    assert.equal(maintenance.validated, true);
    assert.ok(existsSync(join(dir, 'runs', 'new-1.json')) && existsSync(join(dir, 'events/archive/2026-10-01.json')) && existsSync(join(dir, 'digests/2026-10-10-research.md')) && existsSync(join(dir, 'reviews/reviews-2026-10-10.jsonl')));
    assert.ok(!existsSync(join(dir, 'events/archive/2026-05-01.json')) && !existsSync(join(dir, 'digests/2026-05-01-research.md')) && !existsSync(join(dir, 'reviews/reviews-2026-05-01.jsonl')));
    assert.deepEqual(readArchive(join(dir, 'archive', 'events-summary-2026-05.jsonl.gz')).map((r) => r.date), ['2026-05-01', '2026-05-02']);
    assert.deepEqual(readArchive(join(dir, 'archive', 'digests-2026-05.jsonl.gz')), [{ name: '2026-05-01-research.md', text: '# old digest\n' }]);
    assert.equal(readArchive(join(dir, 'archive', 'reviews-2026-05.jsonl.gz')).length, 2);
    const written = JSON.parse(readFileSync(join(dir, 'maintenance.json'), 'utf8'));
    assert.equal(written.lastRunAt, NOW.toISOString());
    assert.deepEqual(checkStateDir(dir).problems, [], 'every file, archives included, passes the strict check');
  } finally {
    cleanup();
  }
});

test('a repeat run changes no archive, and each new day changes only maintenance.json', () => {
  const { dir, cleanup } = stateWith({ 'digests/2026-05-01-research.md': '# old\n', 'events/archive/2026-05-01.json': summary('2026-05-01') });
  try {
    runMaintenance({ stateDir: dir, now: NOW });
    const snapshot = () => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [join(e.parentPath ?? e.path, e.name), readFileSync(join(e.parentPath ?? e.path, e.name)).toString('base64')]));
    const a = snapshot();
    runMaintenance({ stateDir: dir, now: NOW });
    const same = snapshot();
    const sameChanged = Object.keys(same).filter((k) => same[k] !== a[k]).map((k) => k.split('/').at(-1));
    assert.deepEqual(sameChanged, ['maintenance.json'], 'a repeat run reports that it archived nothing, and no archive file changes');
    const before = snapshot();
    runMaintenance({ stateDir: dir, now: new Date(NOW.getTime() + 24 * 3600_000) });
    const b = snapshot();
    const changed = Object.keys(b).filter((k) => b[k] !== before[k]);
    assert.deepEqual(changed.map((k) => k.split('/').at(-1)), ['maintenance.json'], 'the next day: only the record of the run changes, so there is one commit a day');
  } finally {
    cleanup();
  }
});

test('maintenance reports a file that fails its schema and does not hide it', () => {
  const { dir, cleanup } = stateWith({ 'heartbeat.json': { version: 1, surprise: true }, 'secret-notes.txt': 'private' });
  try {
    const { maintenance, problems } = runMaintenance({ stateDir: dir, now: NOW });
    assert.ok(problems.length >= 2);
    assert.equal(maintenance.validated, false);
    assert.match(maintenance.note, /file problem/);
  } finally {
    cleanup();
  }
});

test('rollOldFiles leaves a file that cannot be read or dated', () => {
  const { dir, cleanup } = stateWith({ 'a/bad.json': 'not json', 'a/undated.json': { x: 1 } });
  try {
    const res = rollOldFiles({ dir: join(dir, 'a'), archiveDir: join(dir, 'archive'), name: 'x', keepDays: 1, now: NOW, accept: (f) => f.endsWith('.json'), read: (p) => JSON.parse(readFileSync(p, 'utf8')), dateOf: (r) => r.createdAt, idOf: (r) => String(r.x) });
    assert.equal(res.archived, 0);
    assert.ok(existsSync(join(dir, 'a', 'bad.json')) && existsSync(join(dir, 'a', 'undated.json')));
  } finally {
    cleanup();
  }
});
