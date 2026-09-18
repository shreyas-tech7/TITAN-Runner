/**
 * Crash recovery between every step pair, for real: a pulse process is
 * SIGKILLed right after the model's reply for step N lands (so step N's
 * checkpoint is on disk and step N+1 has not started), and the next pulse
 * must finish the task without re-running a single finished step and
 * without planning twice. N = 0 kills right after the plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPulseProcess, readJsonl } from '../bench/lib/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEPS = ['a', 'b', 'c', 'd'];
// The kill lands 20 ms after the reply; the checkpoint write is synchronous
// and immediate, and every model call takes at least 40 ms (latencyMs), so
// the next step can never finish first.
const KILL_AFTER_MS = 20;

function graph() {
  return { reply: 'graph', graph: { sharedContext: 'crash', tasks: STEPS.map((id, i) => ({ id, title: `Step ${id}`, aspect: i === 1 ? 'code-generation' : 'documentation', description: `Do ${id}.`, dependsOn: i === 0 ? [] : [STEPS[i - 1]], estimatedComplexity: 'low', deliverable: `${id} output` })) } };
}
function envelope(id) {
  return { reply: 'envelope', files: [{ path: `src/${id}.js`, content: `export const ${id} = true;\n` }] };
}
function script(killAfterStep) {
  const plan = graph();
  const rules = [
    { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
    { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation","documentation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
    { kind: 'decompose', sequence: [killAfterStep === 0 ? { ...plan, thenKillAfterMs: KILL_AFTER_MS } : plan] },
    ...STEPS.map((id, i) => ({ kind: 'subtask', taskId: id, sequence: [i + 1 === killAfterStep ? { ...envelope(id), thenKillAfterMs: KILL_AFTER_MS } : envelope(id)] })),
    { kind: 'judge', sequence: [{ reply: 'raw', text: '{"verdict":"pass","reason":"ok","issues":[]}' }] },
    { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
  ];
  return { seed: 9, latencyMs: [40, 50], rules };
}

function world() {
  const scratch = mkdtempSync(join(tmpdir(), 'titan-crash-'));
  const repo = join(scratch, 'repo');
  mkdirSync(repo, { recursive: true });
  cpSync(join(ROOT, 'src'), join(repo, 'src'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(repo, 'package.json'));
  const stateDir = join(scratch, 'state');
  const logs = join(scratch, 'logs');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const githubPath = join(scratch, 'github.json');
  writeFileSync(githubPath, JSON.stringify({ issues: [{ number: 1, title: 'Crash', body: 'Four steps.', user: { login: 'owner' }, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], state: 'open', comments: [] }] }));
  const env = (p, scriptPath) => ({
    PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: `crash-${p}`,
    TITAN_FAKE_PROVIDER: scriptPath, TITAN_FAKE_GITHUB: githubPath, TITAN_FAKE_LOG_DIR: logs, TITAN_FAKE_PULSE_INDEX: String(p), TITAN_FAKE_QUIET: '1',
    TITAN_CLOCK_OFFSET_MS: String((p - 1) * 15 * 60_000), TITAN_LEASE_TTL_MS: '300000',
    GROQ_API_KEY: 'fake-not-a-real-key', TOGETHER_API_KEY: 'fake-not-a-real-key', OPENROUTER_API_KEY: 'fake-not-a-real-key', GEMINI_API_KEY: 'fake-not-a-real-key', HF_API_KEY: 'fake-not-a-real-key',
    TITAN_QUOTA_GROQ_PER_MINUTE: '1000', TITAN_QUOTA_TOGETHER_PER_MINUTE: '1000', TITAN_QUOTA_OPENROUTER_PER_MINUTE: '1000', TITAN_QUOTA_GEMINI_PER_MINUTE: '1000', TITAN_QUOTA_HUGGINGFACE_PER_MINUTE: '1000',
  });
  return { scratch, repo, stateDir, logs, githubPath, env, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

for (const n of [0, 1, 2, 3, 4]) {
  test(`kill after ${n === 0 ? 'the plan' : `step ${n}`}: the next pulse resumes from the checkpoint, plans once, runs each step exactly once, comments once`, async () => {
    const w = world();
    try {
      const s1 = join(w.scratch, 'p1.json');
      writeFileSync(s1, JSON.stringify(script(n)));
      const r1 = await runPulseProcess({ repoRoot: w.repo, stateDir: w.stateDir, env: w.env(1, s1), timeoutMs: 30_000 });
      assert.equal(r1.signal, 'SIGKILL', `pulse 1 should have been killed: exit ${r1.exitCode} ${r1.stderr.slice(-300)}`);
      const tasksAfterKill = JSON.parse(readFileSync(join(w.stateDir, 'tasks.json'), 'utf8')).tasks;
      assert.equal(tasksAfterKill[0].status, 'running', 'died mid-task: still running with a lease');
      assert.ok(existsSync(join(w.stateDir, 'leases', 'issue-1.json')), 'the lease survived the crash');
      const cp = JSON.parse(readFileSync(join(w.stateDir, 'checkpoints', 'issue-1.json'), 'utf8'));
      assert.ok(cp.graph, 'the plan was checkpointed before the kill');
      assert.equal(Object.values(cp.subtasks).filter((s) => s.state === 'complete').length, n, `${n} step(s) checkpointed complete`);

      const s2 = join(w.scratch, 'p2.json');
      writeFileSync(s2, JSON.stringify(script(99)));
      const r2 = await runPulseProcess({ repoRoot: w.repo, stateDir: w.stateDir, env: w.env(2, s2), timeoutMs: 30_000 });
      assert.equal(r2.exitCode, 0, r2.stderr.slice(-500));
      assert.equal(r2.summary?.tasksCompleted, 1, JSON.stringify(r2.summary));
      const tasks = JSON.parse(readFileSync(join(w.stateDir, 'tasks.json'), 'utf8')).tasks;
      assert.equal(tasks[0].status, 'complete');
      assert.ok(tasks[0].attempts >= 1, 'the attempt was counted');

      const calls = readJsonl(join(w.logs, 'provider-calls.jsonl'));
      const perStep = Object.fromEntries(STEPS.map((id) => [id, calls.filter((c) => c.kind === 'subtask' && c.taskId === id).length]));
      assert.deepEqual(perStep, { a: 1, b: 1, c: 1, d: 1 }, `every step ran exactly once across both pulses: ${JSON.stringify(perStep)}`);
      assert.equal(calls.filter((c) => c.kind === 'decompose').length, 1, 'planned once');
      const github = JSON.parse(readFileSync(w.githubPath, 'utf8'));
      assert.equal(github.issues[0].comments.filter((c) => /finished this task/.test(c.body)).length, 1);
      assert.equal(github.issues[0].state, 'closed');
      assert.equal(existsSync(join(w.stateDir, 'leases', 'issue-1.json')), false);
      assert.equal(existsSync(join(w.stateDir, 'checkpoints', 'issue-1.json')), false);
      const events = readJsonl(join(w.stateDir, 'events', `${new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 10)}.jsonl`)).concat(readJsonl(join(w.stateDir, 'events', `${new Date().toISOString().slice(0, 10)}.jsonl`)));
      assert.ok(events.some((e) => e.type === 'reconcile.finished' && e.reclaimed === 1), 'the zombie was reclaimed');
    } finally {
      w.cleanup();
    }
  });
}
