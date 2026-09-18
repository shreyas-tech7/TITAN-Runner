/**
 * @file Turns simulation env vars into `runPulse()` dependencies. Nothing
 * here runs unless one of these is set, so a plain pulse is untouched:
 *
 *   TITAN_FAKE_PROVIDER   path to a fake-provider script JSON, an inline
 *                         JSON object, or the word `happy` for the built-in
 *                         happy-path script (see fakes/fakeProvider.js).
 *   TITAN_FAKE_GITHUB     path to a fake GitHub fixture JSON (persisted in
 *                         place across pulses); `memory` for an empty one.
 *   TITAN_FAKE_LOG_DIR    where the fakes append their call logs
 *                         (`provider-calls.jsonl`, `github-calls.jsonl`).
 *
 * Setting TITAN_FAKE_PROVIDER also turns the network off (`TITAN_NETWORK=off`
 * is enforced by lib/net.js) — a simulation must never reach a real
 * provider even if a key happens to be in the environment.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeProviderAgent, happyPathScript } from './fakeProvider.js';
import { FakeGitHub } from './fakeGitHub.js';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ pools?: Record<string, object>, reviewerChat?: Function, github?: object, fakeProvider?: FakeProviderAgent, fakeGitHub?: FakeGitHub } | null}
 */
export function fakeDepsFromEnv(env = process.env) {
  const providerSpec = env.TITAN_FAKE_PROVIDER;
  const githubSpec = env.TITAN_FAKE_GITHUB;
  if (!providerSpec && !githubSpec) return null;

  const logDir = env.TITAN_FAKE_LOG_DIR || null;
  if (logDir) mkdirSync(logDir, { recursive: true });
  const deps = {};

  if (providerSpec) {
    env.TITAN_NETWORK = 'off';
    const script = loadScript(providerSpec);
    const fake = new FakeProviderAgent({ script, logPath: logDir ? join(logDir, 'provider-calls.jsonl') : null });
    deps.fakeProvider = fake;
    deps.pools = { phase2: fake };
    deps.reviewerChat = fake.chat.bind(fake);
  }

  if (githubSpec) {
    const fixturePath = githubSpec === 'memory' ? null : githubSpec;
    const fake = new FakeGitHub({ fixturePath, logPath: logDir ? join(logDir, 'github-calls.jsonl') : null, repository: env.GITHUB_REPOSITORY || 'fake-owner/fake-repo' });
    deps.fakeGitHub = fake;
    deps.github = fake;
  }

  return deps;
}

function loadScript(spec) {
  if (spec === 'happy') return happyPathScript();
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  if (!existsSync(trimmed)) throw new Error(`TITAN_FAKE_PROVIDER: no such script file: ${trimmed}`);
  return JSON.parse(readFileSync(trimmed, 'utf8'));
}

export default { fakeDepsFromEnv };
