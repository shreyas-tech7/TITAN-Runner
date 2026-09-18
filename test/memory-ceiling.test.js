/**
 * The Runner's memory ceiling, enforced: a real pulse process over the
 * fakes, running a multi-step task end to end, must stay well under the
 * 400 MB the main application is allowed — the pulse shares a runner with
 * nothing, but a leak here would surface as a killed job after a few
 * checkpoints. Peak RSS is sampled from /proc by the harness's runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPulseProcess } from '../bench/lib/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PEAK_RSS_CEILING_KB = 200 * 1024;

test(`one full pulse (six-step task, verification, judge) peaks under ${PEAK_RSS_CEILING_KB / 1024} MB RSS with a 256 MB heap cap`, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'titan-mem-'));
  try {
    const repo = join(scratch, 'repo');
    mkdirSync(repo, { recursive: true });
    cpSync(join(ROOT, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(repo, 'package.json'));
    const stateDir = join(scratch, 'state');
    mkdirSync(stateDir, { recursive: true });
    const steps = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id, i) => ({ id, title: `Step ${id}`, aspect: i === 0 ? 'architecture' : 'code-generation', description: `Do ${id}.`, dependsOn: i === 0 ? [] : [`s${i}`], estimatedComplexity: 'low', deliverable: `src/${id}.js` }));
    const script = {
      seed: 11, latencyMs: [1, 2],
      rules: [
        { kind: 'review', sequence: [{ reply: 'verdict', verdict: 'allow' }] },
        { kind: 'probe', sequence: [{ reply: 'raw', text: '{"strengths":["code-generation"],"weaknesses":[],"latencyClass":"fast","contextWindow":32768}' }] },
        { kind: 'decompose', sequence: [{ reply: 'graph', graph: { sharedContext: 'mem', tasks: steps } }] },
        { kind: 'subtask', sequence: [{ reply: 'envelope', files: [{ path: 'src/out.js', content: `export const out = ${'"x"'.repeat(1)};\n` }] }] },
        { kind: 'judge', sequence: [{ reply: 'raw', text: '{"verdict":"pass","reason":"ok","issues":[]}' }] },
        { kind: '*', sequence: [{ reply: 'prose', text: 'Done.' }] },
      ],
    };
    writeFileSync(join(scratch, 'script.json'), JSON.stringify(script));
    writeFileSync(join(scratch, 'github.json'), JSON.stringify({ issues: [{ number: 1, title: 'Memory', body: 'Six steps.', user: { login: 'owner' }, author_association: 'OWNER', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', labels: [{ name: 'titan-task' }], state: 'open', comments: [] }] }));
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      GITHUB_REPOSITORY: 'owner/repo', TITAN_FAKE_PROVIDER: join(scratch, 'script.json'), TITAN_FAKE_GITHUB: join(scratch, 'github.json'), TITAN_FAKE_QUIET: '1',
      GROQ_API_KEY: 'fake-not-a-real-key', TOGETHER_API_KEY: 'fake-not-a-real-key', OPENROUTER_API_KEY: 'fake-not-a-real-key', GEMINI_API_KEY: 'fake-not-a-real-key', HF_API_KEY: 'fake-not-a-real-key',
      TITAN_QUOTA_GROQ_PER_MINUTE: '1000', TITAN_QUOTA_TOGETHER_PER_MINUTE: '1000', TITAN_QUOTA_OPENROUTER_PER_MINUTE: '1000', TITAN_QUOTA_GEMINI_PER_MINUTE: '1000', TITAN_QUOTA_HUGGINGFACE_PER_MINUTE: '1000',
    };
    const r = await runPulseProcess({ repoRoot: repo, stateDir, env, timeoutMs: 60_000, sampleMs: 3 });
    assert.equal(r.exitCode, 0, r.stderr.slice(-800));
    assert.ok(r.summary && r.summary.tasksCompleted === 1, JSON.stringify(r.summary));
    assert.ok(r.peakRssKb > 0, 'RSS was sampled');
    assert.ok(r.peakRssKb < PEAK_RSS_CEILING_KB, `peak RSS ${Math.round(r.peakRssKb / 1024)} MB exceeds the ${PEAK_RSS_CEILING_KB / 1024} MB ceiling`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
