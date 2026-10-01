/**
 * The safety rules engine (config/safety-rules.yml, policy/safetyRules.js,
 * policy/approvalLog.js): classification, the hard floor, the loader's
 * fallbacks, the approval log, and the end-to-end behaviour through
 * `runPulse()`. Zero network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../src/policy/engine.js';
import {
  ACTION_CATEGORIES, HARD_ASK, DEFAULT_SAFETY_RULES, DEFAULT_RULES_PATH,
  classifyAction, categoryForApprovalKey, evaluateRules, loadSafetyRules, parseSafetyRules,
} from '../src/policy/safetyRules.js';
import { ApprovalLog, summarizeApprovals } from '../src/policy/approvalLog.js';
import { parseYamlSubset, YamlSubsetError } from '../src/lib/miniYaml.js';
import { applyCommand } from '../src/issueSync.js';
import { buildSafetyView } from '../src/observability/views.js';
import { runPulse } from '../src/engine/pulse.js';
import { FakeProviderAgent } from '../src/fakes/fakeProvider.js';
import { FakeGitHub } from '../src/fakes/fakeGitHub.js';
import { readEventsDir } from '../src/observability/events.js';

const control = (over = {}) => ({ killSwitch: false, safeMode: false, autonomy: 'autonomous', ...over });
const GIT_COMMIT_TOOL = { kind: 'tool', toolId: 'git_commit', effect: 'local_write', args: { message: 'x' } };
const SELF_IMPROVE = { kind: 'self-improve', effect: 'external', runId: 'r1' };

/* -------------------------------------------------------------------------- */
/* The requirement: a git-commit action always asks, whatever else is set      */
/* -------------------------------------------------------------------------- */

test('a git-commit-classified action is ALWAYS ask-first, regardless of the other rules, the dial, and approve-all', () => {
  assert.equal(classifyAction(GIT_COMMIT_TOOL), 'git-commit');
  assert.equal(classifyAction(SELF_IMPROVE), 'git-commit');

  // A rules file that tries to auto-approve it, with a permissive default.
  const permissive = { ...DEFAULT_SAFETY_RULES, default: 'auto', autoApprove: [...ACTION_CATEGORIES], alwaysAsk: [] };
  for (const action of [GIT_COMMIT_TOOL, SELF_IMPROVE]) {
    for (const autonomy of ['propose', 'approval', 'autonomous']) {
      for (const rules of [DEFAULT_SAFETY_RULES, permissive, undefined]) {
        const d = decide({ action, control: control({ autonomy }), rules });
        assert.equal(d.decision, 'approve', `${action.kind}/${autonomy}: ${d.reason}`);
        assert.equal(d.category, 'git-commit');
        assert.equal(d.source === 'safety-rules' || d.source === 'level', true);
      }
    }
  }
  // `approve all` given in advance does not clear it...
  const withAll = { approvals: { all: { decision: 'approved', by: 'owner' } } };
  assert.equal(decide({ action: GIT_COMMIT_TOOL, control: control(), task: withAll }).decision, 'approve');
  assert.equal(decide({ action: SELF_IMPROVE, control: control(), task: withAll }).decision, 'approve');
  // ...only an approval naming the exact key does.
  const exact = { approvals: { 'self-improve:r1': { decision: 'approved', by: 'owner' } } };
  assert.equal(decide({ action: SELF_IMPROVE, control: control(), task: exact }).decision, 'allow');
  // Denial always wins; the kill switch and dry-run still stop it outright.
  assert.equal(decide({ action: SELF_IMPROVE, control: control(), task: { approvals: { all: { decision: 'denied' } } } }).decision, 'deny');
  assert.equal(decide({ action: SELF_IMPROVE, control: control({ killSwitch: true }) }).decision, 'deny');
  assert.equal(decide({ action: SELF_IMPROVE, control: control({ autonomy: 'dry-run' }) }).decision, 'deny');
});

test('every hard-ask category asks even when listed under auto_approve, and the loader warns about it', () => {
  const rules = parseSafetyRules(`version: 1\nauto_approve:\n${ACTION_CATEGORIES.map((c) => `  - ${c}`).join('\n')}\n`);
  assert.ok(rules.warnings.some((w) => w.includes('git-commit') && w.includes('hard-ask')));
  const samples = {
    'git-commit': GIT_COMMIT_TOOL,
    'file-delete': { kind: 'tool', toolId: 'delete_file', effect: 'local_write', args: { path: 'a.txt' } },
    'credential-change': { kind: 'tool', toolId: 'rotate_secret', effect: 'external', args: {} },
    'state-mutation': { kind: 'tool', toolId: 'edit_file', effect: 'local_write', args: { path: 'state/tasks.json' } },
  };
  for (const category of HARD_ASK) {
    const action = samples[category];
    assert.equal(classifyAction(action), category);
    const v = evaluateRules(action, rules);
    assert.deepEqual([v.ask, v.hard, v.rule], [true, true, 'hard-floor'], category);
    assert.equal(decide({ action, control: control(), rules }).decision, 'approve', category);
  }
});

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

test('classification: built-in tools, deliveries, reads, and the signals for tools added later', () => {
  const t = (toolId, effect, args = {}) => classifyAction({ kind: 'tool', toolId, effect, args });
  // Built-ins use the fixed table (their arguments are jailed).
  assert.equal(t('repo_read_file', 'read', { path: '.env' }), 'read');
  assert.equal(t('repo_search', 'read'), 'read');
  assert.equal(t('workspace_write', 'local_write', { path: 'state/notes.md' }), 'scratch-write');
  assert.equal(t('http_fetch', 'external', { url: 'https://example.com' }), 'external-fetch');
  assert.equal(classifyAction({ kind: 'deliver', effect: 'external' }), 'issue-comment');
  // A read is a read even with a scary name; nothing is written.
  assert.equal(t('git_log', 'read'), 'read');
  // Later tools: by name…
  assert.equal(t('git_push', 'external'), 'git-commit');
  assert.equal(t('gitCommit', 'local_write'), 'git-commit');
  assert.equal(t('remove_dir', 'local_write'), 'file-delete');
  assert.equal(t('rm', 'local_write'), 'file-delete');
  assert.equal(t('set_api_key', 'external'), 'credential-change');
  assert.equal(t('update_token', 'external'), 'credential-change');
  // …by path argument…
  assert.equal(t('write_file', 'local_write', { path: '.env.production' }), 'credential-change');
  assert.equal(t('write_file', 'local_write', { path: 'config/id_rsa' }), 'credential-change');
  assert.equal(t('write_file', 'local_write', { path: '.git/config' }), 'git-commit');
  assert.equal(t('write_file', 'local_write', { path: 'state/tasks.json' }), 'state-mutation');
  assert.equal(t('write_file', 'local_write', { path: './state/tasks.json' }), 'state-mutation');
  assert.equal(t('write_file', 'local_write', { path: 'state\\tasks.json' }), 'state-mutation');
  // …appending to state/ is the one allowed state write.
  assert.equal(t('append_line', 'local_write', { path: 'state/approval-log.jsonl' }), 'state-append');
  assert.equal(t('write_file', 'local_write', { path: 'state/x.log', mode: 'append' }), 'state-append');
  // Strictest signal wins.
  assert.equal(t('delete_file', 'local_write', { path: '.env' }), 'credential-change');
  // Everything else falls back on the declared effect; no caller-supplied category can loosen it.
  assert.equal(t('write_notes', 'local_write', { path: 'notes.md' }), 'scratch-write');
  assert.equal(t('post_webhook', 'external'), 'external-effect');
  assert.equal(t('weird', 'mystery'), 'external-effect');
  assert.equal(classifyAction({ kind: 'tool', toolId: 'git_commit', effect: 'local_write', category: 'read' }), 'git-commit');
  assert.equal(classifyAction({ kind: 'tool', toolId: 'post_webhook', effect: 'external', category: 'read' }), 'external-effect');
  // Words, not substrings: `rm` does not match `repo_search`, `git` not `digit`.
  assert.equal(t('digit_lookup', 'external'), 'external-effect');
  assert.equal(t('form_summary', 'local_write'), 'scratch-write');
});

test('approval keys map back to a category for the log', () => {
  assert.equal(categoryForApprovalKey('self-improve:abc'), 'git-commit');
  assert.equal(categoryForApprovalKey('deliver:abc'), 'issue-comment');
  assert.equal(categoryForApprovalKey('tool:http_fetch:1a2b3c4d'), 'external-fetch');
  assert.equal(categoryForApprovalKey('tool:delete_file:1a2b3c4d'), 'file-delete');
  assert.equal(categoryForApprovalKey('all'), 'all');
  assert.equal(categoryForApprovalKey('???'), 'unknown');
});

/* -------------------------------------------------------------------------- */
/* Behaviour that must not change                                              */
/* -------------------------------------------------------------------------- */

test('the autonomous default is unchanged for everything that is not a hard-ask category', () => {
  const at = (action, autonomy = 'autonomous') => decide({ action, control: control({ autonomy }) }).decision;
  assert.equal(at({ kind: 'tool', toolId: 'repo_read_file', effect: 'read' }), 'allow');
  assert.equal(at({ kind: 'tool', toolId: 'workspace_write', effect: 'local_write', args: { path: 'a.txt' } }), 'allow');
  assert.equal(at({ kind: 'tool', toolId: 'http_fetch', effect: 'external', args: { url: 'https://example.com' } }), 'allow');
  assert.equal(at({ kind: 'deliver', effect: 'external', runId: 'r' }), 'allow');
  // The dial still layers on top of auto-approved categories.
  assert.equal(at({ kind: 'deliver', effect: 'external', runId: 'r' }, 'propose'), 'approve');
  assert.equal(at({ kind: 'tool', toolId: 'workspace_write', effect: 'local_write', args: {} }, 'approval'), 'approve');
  assert.equal(at({ kind: 'tool', toolId: 'workspace_write', effect: 'local_write', args: {} }, 'dry-run'), 'deny');
});

test('a category moved to always_ask, or left off the lists under default: ask, asks; default: auto allows', () => {
  const ask = parseSafetyRules('version: 1\nauto_approve:\n  - read\nalways_ask:\n  - external-fetch\n');
  const fetchAction = { kind: 'tool', toolId: 'http_fetch', effect: 'external', args: {} };
  assert.deepEqual([evaluateRules(fetchAction, ask).ask, evaluateRules(fetchAction, ask).rule], [true, 'always_ask']);
  assert.equal(decide({ action: fetchAction, control: control(), rules: ask }).decision, 'approve');
  // Unlisted + default ask.
  const unlisted = { kind: 'deliver', effect: 'external', runId: 'r' };
  assert.deepEqual([evaluateRules(unlisted, ask).ask, evaluateRules(unlisted, ask).rule], [true, 'default']);
  // default: auto
  const auto = parseSafetyRules('version: 1\ndefault: auto\n');
  assert.equal(evaluateRules(unlisted, auto).ask, false);
  // A category in both lists: always_ask wins.
  const both = parseSafetyRules('version: 1\nauto_approve:\n  - issue-comment\nalways_ask:\n  - issue-comment\n');
  assert.ok(both.warnings.some((w) => w.includes('both lists')));
  assert.equal(evaluateRules(unlisted, both).ask, true);
});

/* -------------------------------------------------------------------------- */
/* The shipped file, the loader, the YAML subset                                */
/* -------------------------------------------------------------------------- */

test('the shipped config/safety-rules.yml parses cleanly and matches the built-in fallback exactly', () => {
  const loaded = loadSafetyRules();
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.source, 'config/safety-rules.yml');
  assert.equal(loaded.version, DEFAULT_SAFETY_RULES.version);
  assert.equal(loaded.default, DEFAULT_SAFETY_RULES.default);
  assert.deepEqual(loaded.autoApprove, [...DEFAULT_SAFETY_RULES.autoApprove]);
  assert.deepEqual(loaded.alwaysAsk, [...DEFAULT_SAFETY_RULES.alwaysAsk]);
  // Every category the file names exists; every hard-ask category is on the always_ask list.
  for (const c of [...loaded.autoApprove, ...loaded.alwaysAsk]) assert.ok(ACTION_CATEGORIES.includes(c), c);
  for (const c of HARD_ASK) assert.ok(loaded.alwaysAsk.includes(c), `${c} should be listed under always_ask`);
  assert.ok(existsSync(DEFAULT_RULES_PATH));
});

test('a missing rules file falls back quietly; a malformed or unsupported one falls back with a warning and the floor intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-rules-'));
  try {
    const missing = loadSafetyRules({ path: join(dir, 'nope.yml') });
    assert.equal(missing.warnings.length, 0);
    assert.match(missing.source, /built-in/);
    assert.deepEqual([...missing.alwaysAsk], [...DEFAULT_SAFETY_RULES.alwaysAsk]);

    const bad = join(dir, 'bad.yml');
    for (const text of ['version: 2\n', 'version: 1\nauto_approve: read\n', 'version: 1\n\tfoo: bar\n', 'version: 1\ndefault: maybe\n', 'not yaml at all\n']) {
      writeFileSync(bad, text);
      const r = loadSafetyRules({ path: bad });
      assert.equal(r.warnings.length, 1, text);
      assert.match(r.warnings[0], /ignored/);
      assert.match(r.source, /built-in/);
      // The floor survives a bad file.
      assert.equal(decide({ action: SELF_IMPROVE, control: control(), rules: r }).decision, 'approve');
    }
    const unreadable = loadSafetyRules({ path: bad, readFile: () => { throw Object.assign(new Error('EACCES: nope'), { code: 'EACCES' }); } });
    assert.match(unreadable.warnings[0], /could not read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown categories in the file are ignored with a warning, not an error', () => {
  const r = parseSafetyRules('version: 1\nauto_approve:\n  - read\n  - teleport\n');
  assert.deepEqual(r.warnings, ['unknown category "teleport" is ignored']);
});

test('miniYaml: the supported subset, and loud rejection of everything else', () => {
  const doc = parseYamlSubset([
    '# comment', 'version: 1', 'name: "quoted # not a comment"  # trailing comment', "single: 'it''s'", 'flag: true', 'nothing: null', 'ratio: 2.5',
    'list:', '  - a', '  - "b: c"', '  - d # note', 'map:', '  k-1: v1', '  k2: "v 2"', '',
  ].join('\n'));
  assert.deepEqual({ ...doc, map: { ...doc.map } }, {
    version: 1, name: 'quoted # not a comment', single: "it's", flag: true, nothing: null, ratio: 2.5,
    list: ['a', 'b: c', 'd'], map: { 'k-1': 'v1', k2: 'v 2' },
  });
  for (const [text, re] of [
    ['a: 1\na: 2\n', /duplicate key/],
    ['a:\n  - x\n  k: v\n', /mix/],
    ['a:\n  k: v\n  - x\n', /mix/],
    ['a:\n  - k: v\n', /lists of maps/],
    ['  orphan: 1\n', /no parent/],
    ['a:\n\t- x\n', /tabs/],
    ['a: [1, 2]\n', /unsupported/],
    ['a: &anchor x\n', /unsupported/],
    ['a: "unterminated\n', /unterminated/],
    ['__proto__: x\n', /forbidden/],
    ['a:\n  -\n', /empty list item/],
    ['just a sentence\n', /expected/],
  ]) {
    assert.throws(() => parseYamlSubset(text), (e) => e instanceof YamlSubsetError && re.test(e.message) && Number.isInteger(e.line), text);
  }
  assert.equal(Object.getPrototypeOf(parseYamlSubset('a: 1')), null, 'no prototype to pollute');
});

/* -------------------------------------------------------------------------- */
/* The approval log                                                            */
/* -------------------------------------------------------------------------- */

test('the approval log is append-only JSONL, scrubs secrets, and skips torn lines on read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-alog-'));
  try {
    const path = join(dir, 'state', 'approval-log.jsonl');
    const log = new ApprovalLog({ path, now: () => new Date('2026-05-01T00:00:00.000Z') });
    assert.deepEqual(log.read(), []);
    log.append({ taskId: 'issue-1', issueNumber: 1, key: 'self-improve:r1', category: 'git-commit', decision: 'approved', by: 'owner', via: 'issue-comment' });
    const first = readFileSync(path, 'utf8');
    log.append({ taskId: 'issue-2', issueNumber: 2, key: 'tool:x:ghp_abcdefghijklmnopqrstuvwxyz0123456789', category: 'unknown', decision: 'denied', by: 'owner', via: 'control-workflow' });
    const both = readFileSync(path, 'utf8');
    assert.ok(both.startsWith(first), 'earlier lines are never rewritten');
    assert.ok(!both.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'a credential-shaped key is scrubbed before it reaches a public repo');
    writeFileSync(path, `${both}{"torn":\n`);
    const entries = log.read();
    assert.equal(entries.length, 2);
    assert.deepEqual([entries[0].v, entries[0].at, entries[0].decision], [1, '2026-05-01T00:00:00.000Z', 'approved']);
    const s = summarizeApprovals(entries);
    assert.deepEqual([s.total, s.approved, s.denied], [2, 1, 1]);
    assert.deepEqual(s.byCategory['git-commit'], { approved: 1, denied: 0 });
    assert.equal(s.recent[0].taskId, 'issue-2', 'recent is newest first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCommand logs every approve/deny with its category and channel, and a broken log never undoes the decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-alog-'));
  try {
    const log = new ApprovalLog({ path: join(dir, 'approval-log.jsonl') });
    const now = () => new Date('2026-05-01T00:00:00.000Z');
    const task = { id: 'issue-7', issueNumber: 7, status: 'waiting', waitReason: 'approval', history: [], attempts: 0 };
    assert.equal(applyCommand(task, { verb: 'approve', args: ['self-improve:run-1'] }, { now, events: null, by: 'owner', approvalLog: log, via: 'issue-comment' }), 'approval-recorded');
    const t2 = { id: 'issue-8', issueNumber: null, status: 'pending', history: [] };
    applyCommand(t2, { verb: 'deny', args: ['tool:delete_file:ab12cd34'] }, { now, events: null, by: 'dispatcher', approvalLog: log, via: 'control-workflow' });
    const [a, d] = log.read();
    assert.deepEqual([a.taskId, a.issueNumber, a.key, a.category, a.decision, a.by, a.via], ['issue-7', 7, 'self-improve:run-1', 'git-commit', 'approved', 'owner', 'issue-comment']);
    assert.deepEqual([d.taskId, d.category, d.decision, d.via], ['issue-8', 'file-delete', 'denied', 'control-workflow']);
    // Non-approval commands write nothing.
    applyCommand({ id: 'x', status: 'pending', history: [] }, { verb: 'priority', args: ['high'] }, { now, events: null, by: 'owner', approvalLog: log });
    assert.equal(log.read().length, 2);
    // A log that throws cannot block the recorded decision.
    const broken = { append() { throw new Error('disk full'); } };
    const t3 = { id: 'issue-9', status: 'pending', history: [] };
    assert.equal(applyCommand(t3, { verb: 'approve', args: ['all'] }, { now, events: null, by: 'owner', approvalLog: broken }), 'approval-recorded');
    assert.equal(t3.approvals.all.decision, 'approved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the safety view carries the rules in force, the hard floor, warnings, and the approval summary', () => {
  const rules = { ...DEFAULT_SAFETY_RULES, source: 'config/safety-rules.yml', warnings: ['w1'] };
  const view = buildSafetyView({ rules, approvals: [{ decision: 'approved', category: 'git-commit', taskId: 't', key: 'k', by: 'o', at: 'a' }], now: () => new Date('2026-05-01T00:00:00.000Z') });
  assert.equal(view.updatedAt, '2026-05-01T00:00:00.000Z');
  assert.deepEqual(view.rules.hardFloor, [...HARD_ASK]);
  assert.deepEqual(view.rules.warnings, ['w1']);
  assert.equal(view.rules.source, 'config/safety-rules.yml');
  assert.deepEqual([view.approvals.total, view.approvals.approved], [1, 1]);
});

/* -------------------------------------------------------------------------- */
/* End to end through runPulse()                                               */
/* -------------------------------------------------------------------------- */

const OWNER = { login: 'owner-login' };
function issue(number, title, body, labels = ['titan-task']) {
  return { number, title, body, user: OWNER, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: labels.map((name) => ({ name })), state: 'open', comments: [] };
}
const ONE_CODE_STEP = { reply: 'graph', graph: { sharedContext: 'ctx', tasks: [{ id: 'only', title: 'Only', aspect: 'code-generation', description: 'Do it.', dependsOn: [], estimatedComplexity: 'low', deliverable: 'src/only.js' }] } };
const ENVELOPE = { reply: 'envelope', files: [{ path: 'src/only.js', content: 'export const only = true;\n' }] };
const SCRIPT = {
  seed: 5,
  latencyMs: [1, 3],
  rules: [
    { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
    { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
    { kind: 'decompose', sequence: [ONE_CODE_STEP] },
    { kind: 'subtask', sequence: [ENVELOPE] },
    { kind: 'judge', sequence: [{ reply: 'raw', text: '{"verdict":"pass","reason":"ok","issues":[]}' }] },
    { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
  ],
};

/**
 * `proposeSelfImprovement` runs REAL git (branch, commit, push to origin) in
 * the cwd. Every test here that can reach delivery must inject this stub; an
 * earlier version of this file did not and pushed a branch to the real remote.
 */
function stubProposeSelfImprovement(calls) {
  return async (task) => {
    calls.push(task.id);
    return { status: 'pr-open', prNumber: 99, prUrl: 'https://example.invalid/pull/99' };
  };
}

function world(labels) {
  const stateDir = mkdtempSync(join(tmpdir(), 'titan-safety-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'titan-repo-'));
  mkdirSync(join(repoRoot, 'src'));
  const github = new FakeGitHub({ fixture: { issues: [issue(1, 'Improve it', 'Make a small improvement.', labels)] }, repository: 'owner-login/repo', now: () => new Date('2026-04-01T09:00:00.000Z') });
  const fake = new FakeProviderAgent({ script: SCRIPT, quiet: true });
  const proposals = [];
  const deps = (extra = {}) => ({ stateDir, repoRoot, github, pools: { phase2: fake }, reviewerChat: fake.chat.bind(fake), dryRun: false, now: () => new Date('2026-04-01T09:00:00.000Z'), proposeSelfImprovement: stubProposeSelfImprovement(proposals), ...extra });
  const task = () => JSON.parse(readFileSync(join(stateDir, 'tasks.json'), 'utf8')).tasks.find((t) => t.id === 'issue-1');
  return { stateDir, github, deps, task, proposals, events: () => readEventsDir(join(stateDir, 'events')), cleanup: () => { rmSync(stateDir, { recursive: true, force: true }); rmSync(repoRoot, { recursive: true, force: true }); } };
}

test('end to end: a self-improve task at the DEFAULT autonomy parks for approval of its git commit; approving the exact key is logged', async () => {
  const w = world(['titan-task', 'titan-self-improve']);
  try {
    await runPulse(w.deps({ pulseId: 'p1' }));
    const t = w.task();
    assert.equal(t.status, 'waiting', JSON.stringify(t.history?.map((h) => h.reason)));
    assert.equal(t.waitReason, 'approval');
    const ask = w.github.data.issues[0].comments.find((c) => c.body.includes('/titan approve self-improve:'));
    assert.ok(ask, 'the approval request was posted on the issue');
    const key = ask.body.match(/\/titan approve (self-improve:[0-9a-f-]+)/)[1];
    const decision = w.events().find((e) => e.type === 'policy.decision' && e.action === 'self-improve');
    assert.deepEqual([decision.outcome, decision.category, decision.autonomy], ['approve', 'git-commit', 'autonomous']);

    // A blanket "approve all" is ignored for a commit; the exact key is honoured.
    w.github.data.issues[0].comments.push({ id: 5, body: '/titan approve all', created_at: '2026-04-01T09:30:00.000Z', user: OWNER, author_association: 'OWNER' });
    w.github.data.issues[0].updated_at = '2026-04-01T09:30:00.000Z';
    await runPulse(w.deps({ pulseId: 'p2', now: () => new Date('2026-04-01T09:31:00.000Z') }));
    assert.equal(w.task().status, 'waiting', 'approve-all did not clear the git commit');
    assert.deepEqual(w.proposals, [], 'nothing was proposed (no git) before the exact key was approved');
    assert.ok(w.events().filter((e) => e.type === 'policy.decision' && e.action === 'self-improve').every((e) => e.outcome === 'approve'));

    w.github.data.issues[0].comments.push({ id: 6, body: `/titan approve ${key}`, created_at: '2026-04-01T10:30:00.000Z', user: OWNER, author_association: 'OWNER' });
    w.github.data.issues[0].updated_at = '2026-04-01T10:30:00.000Z';
    await runPulse(w.deps({ pulseId: 'p3', now: () => new Date('2026-04-01T10:31:00.000Z') }));
    const allowed = w.events().filter((e) => e.type === 'policy.decision' && e.action === 'self-improve').at(-1);
    assert.equal(allowed.outcome, 'allow', 'the exact-key approval cleared it');
    assert.deepEqual(w.proposals, ['issue-1'], 'the (stubbed) self-improvement ran exactly once, after the exact-key approval');
    assert.equal(w.task().status, 'pr-open');

    const lines = readFileSync(join(w.stateDir, 'approval-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, 'both decisions the human made are in the log');
    assert.deepEqual(lines.map((l) => [l.key === 'all' ? 'all' : 'exact', l.category, l.decision, l.by, l.via]), [
      ['all', 'all', 'approved', 'owner-login', 'issue-comment'],
      ['exact', 'git-commit', 'approved', 'owner-login', 'issue-comment'],
    ]);

    // The derived view the dashboard reads.
    const view = JSON.parse(readFileSync(join(w.stateDir, 'views', 'safety.json'), 'utf8'));
    assert.deepEqual(view.rules.hardFloor, [...HARD_ASK]);
    assert.equal(view.approvals.total, 2);
    assert.equal(view.approvals.byCategory['git-commit'].approved, 1);
  } finally {
    w.cleanup();
  }
});

test('end to end: an ordinary task is unaffected by the rules — it runs, verifies, and delivers with no approval', async () => {
  const w = world(['titan-task']);
  try {
    const s = await runPulse(w.deps({ pulseId: 'p1' }));
    assert.equal(s.tasksCompleted, 1, JSON.stringify(w.task()?.failure));
    assert.equal(w.task().status, 'complete');
    assert.equal(existsSync(join(w.stateDir, 'approval-log.jsonl')), false, 'nothing was decided by a human, so nothing is logged');
    const d = w.events().find((e) => e.type === 'policy.decision' && e.action === 'deliver');
    assert.deepEqual([d.outcome, d.category], ['allow', 'issue-comment']);
  } finally {
    w.cleanup();
  }
});

test('end to end: a malformed rules file is recorded as a warning event and the built-in floor still applies', async () => {
  const w = world(['titan-task', 'titan-self-improve']);
  const bad = join(w.stateDir, 'bad-rules.yml');
  try {
    mkdirSync(w.stateDir, { recursive: true });
    writeFileSync(bad, 'version: 1\nauto_approve:\n  - git-commit\n  - [broken\n');
    await runPulse(w.deps({ pulseId: 'p1', safetyRulesPath: bad }));
    const warn = w.events().find((e) => e.type === 'policy.rules-warning');
    assert.ok(warn, 'the bad file was reported');
    assert.match(warn.warnings[0], /ignored/);
    assert.equal(w.task().status, 'waiting');
    assert.equal(w.task().waitReason, 'approval');
    const view = JSON.parse(readFileSync(join(w.stateDir, 'views', 'safety.json'), 'utf8'));
    assert.equal(view.rules.warnings.length, 1);
  } finally {
    w.cleanup();
  }
});
