/**
 * @file The daily research digest: once per UTC day, ONE low-priority call
 * to a free-tier provider from the existing pool, written as
 * `state/digests/<date>-research.md` next to the weekly rollups. It runs
 * inside the existing 15-minute pulse (no second scheduler) and is gated
 * here to once a day.
 *
 * Honest about what it is: the models in the free pool have no web access,
 * so the digest is the model's own training knowledge, labelled as such at
 * the top of every file. It is a list of leads to verify, not research in
 * the human sense.
 *
 * Degrades gracefully by design — it must never fail the pulse:
 *   - disabled (`TITAN_RESEARCH=0`), dry-run, kill switch, drain, autonomy
 *     dry-run, or a safety-rules file that stops auto-approving a state
 *     append: skipped, nothing written;
 *   - no provider configured: skipped, nothing written;
 *   - every provider rate-limited / down / out of quota (the call uses
 *     `priority: 'low'`, so the quota ledger also keeps the high-priority
 *     reserve for real tasks): recorded in `state/research.json` and retried
 *     no sooner than `TITAN_RESEARCH_RETRY_MINUTES` (default 180);
 *   - an empty or unusable answer: same as above.
 * No exception escapes `runDailyResearch`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseYamlSubset } from '../lib/miniYaml.js';
import { redactString } from '../lib/redact.js';
import { scrubForState } from '../lib/secretScrub.js';
import { evaluateRules, DEFAULT_SAFETY_RULES } from '../policy/safetyRules.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('research');

export const RESEARCH_VERSION = 1;
export const DEFAULT_TOPICS_PATH = fileURLToPath(new URL('../../config/research-topics.yml', import.meta.url));
const MAX_TOPICS_CAP = 6;
const MAX_TOPIC_PROMPT_CHARS = 400;
const MAX_DIGEST_CHARS = 6000;
const MIN_USABLE_CHARS = 80;
const DEFAULT_RETRY_MINUTES = 180;
const CALL_TIMEOUT_MS = 60_000;
// Headroom, not length: the prompt asks for under 350 words. Gemini 2.5 models
// count hidden "thinking" tokens against the output limit, and the first live
// run with 700 spent nearly all of it (949 tokens in total, per the quota
// ledger) and left too little text to use.
const MAX_TOKENS = 2048;

/** @param {NodeJS.ProcessEnv} [env] */
export function researchEnabledFromEnv(env = process.env) {
  return env.TITAN_RESEARCH !== '0';
}

/**
 * @param {{ path?: string, readFile?: (p: string) => string }} [opts]
 * @returns {{ topics: Array<{id: string, prompt: string}>, maxTopics: number, source: string, warnings: string[] }}
 */
export function loadResearchTopics(opts = {}) {
  const path = opts.path ?? DEFAULT_TOPICS_PATH;
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const empty = (warnings) => ({ topics: [], maxTopics: 0, source: 'none', warnings });
  let text;
  try {
    text = readFile(path);
  } catch (err) {
    return err?.code === 'ENOENT' ? empty([]) : empty([`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  try {
    const doc = parseYamlSubset(text);
    if (doc.version !== 1) throw new Error(`unsupported or missing "version" (expected 1, got ${JSON.stringify(doc.version)})`);
    const raw = doc.max_topics ?? 3;
    const maxTopics = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_TOPICS_CAP) : 3;
    if (doc.topics == null || Array.isArray(doc.topics) || typeof doc.topics !== 'object') throw new Error('"topics" must be a map of topic-id: "what to cover"');
    const warnings = [];
    const topics = [];
    for (const [id, prompt] of Object.entries(doc.topics)) {
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        warnings.push(`topic "${id}" ignored: needs a non-empty string`);
        continue;
      }
      topics.push({ id, prompt: prompt.trim().slice(0, MAX_TOPIC_PROMPT_CHARS) });
    }
    return { topics, maxTopics, source: path.replace(/^.*[\\/]config[\\/]/, 'config/'), warnings };
  } catch (err) {
    return empty([`config/research-topics.yml ignored: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

/** Up to `maxTopics` topics, rotating by UTC day so a long list is covered over time. */
export function pickTopics(topics, maxTopics, date) {
  if (topics.length <= maxTopics) return topics;
  const day = Math.floor(date.getTime() / 86_400_000);
  const start = day % topics.length;
  return Array.from({ length: maxTopics }, (_, i) => topics[(start + i) % topics.length]);
}

/** @param {Array<{id: string, prompt: string}>} topics @param {string} dateStr */
export function buildResearchMessages(topics, dateStr) {
  const list = topics.map((t, i) => `${i + 1}. ${t.id}: ${t.prompt}`).join('\n');
  return [
    {
      role: 'system',
      content: 'You write a short daily research digest for a small team that runs an autonomous agent system on free-tier AI providers only. You have no web access and no tools: write only from your training knowledge, say so plainly when you are unsure, and never invent URLs, version numbers, dates, prices or quotations. Output Markdown only.',
    },
    {
      role: 'user',
      content: `Date: ${dateStr}.\n\nFor each topic below, write a section headed "## <topic-id>" with exactly three short bullets: what matters, why it matters to this system, and one thing worth verifying. Keep the whole digest under 350 words.\n\nTopics:\n${list}`,
    },
  ];
}

/** Strip a wrapping code fence, scrub credentials/emails, cap the length. */
export function sanitizeDigestBody(text) {
  let body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const fenced = body.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fenced) body = fenced[1].trim();
  body = redactString(body);
  if (body.length > MAX_DIGEST_CHARS) body = `${body.slice(0, MAX_DIGEST_CHARS).replace(/\s+\S*$/, '')}\n\n_(truncated)_`;
  return body;
}

/** @param {{ date: string, at: string, provider: string, model: string, body: string }} d */
export function renderDigest({ date, at, provider, model, body }) {
  return [
    `# Research digest — ${date}`,
    '',
    `> Generated by TITAN-Runner at ${at} using ${provider} (${model}).`,
    '> A free-tier model wrote this from its own training knowledge: it had no web access and cited no live sources. Treat every claim as a lead to verify, not a fact.',
    '',
    body,
    '',
  ].join('\n');
}

/** @param {string} path */
function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @typedef {object} ResearchDeps
 * @property {{ writeView: Function, writeJson: Function, paths: { stateDir: string, digests: string, research: string } }} store
 * @property {{ chat: Function, configuredIds: () => string[] }} registry
 * @property {() => Date} now
 * @property {{ append: Function }|null} [events]
 * @property {{ killSwitch?: boolean, drain?: boolean, autonomy?: string }} [control]
 * @property {import('../policy/safetyRules.js').SafetyRules} [rules]
 * @property {boolean} [enabled]
 * @property {boolean} [dryRun]
 * @property {() => boolean} [shouldStop] True when the pulse is out of time/budget.
 * @property {{ topics: Array<{id: string, prompt: string}>, maxTopics: number, warnings: string[] }} [topicsConfig]
 * @property {number} [retryMinutes]
 */

/**
 * @param {ResearchDeps} deps
 * @returns {Promise<{ status: 'written'|'skipped', reason: string, date: string, file?: string, provider?: string, model?: string }>}
 */
export async function runDailyResearch(deps) {
  const now = deps.now();
  const date = now.toISOString().slice(0, 10);
  const skipped = (reason, extra = {}) => ({ status: 'skipped', reason, date, ...extra });
  try {
    // Quiet skips: nothing written, nothing emitted.
    if (deps.enabled === false) return skipped('disabled');
    if (deps.dryRun) return skipped('dry-run');
    const control = deps.control ?? {};
    if (control.killSwitch) return skipped('kill-switch');
    if (control.drain) return skipped('drain');
    if (control.autonomy === 'dry-run') return skipped('autonomy-dry-run');
    if (deps.shouldStop?.()) return skipped('pulse-budget');

    // The digest is an append under state/: it needs the rules to auto-approve that.
    const file = `${date}-research.md`;
    const digestPath = join(deps.store.paths.digests, file);
    const verdict = evaluateRules({ kind: 'tool', toolId: 'daily_research_digest', effect: 'local_write', args: { path: `state/digests/${file}`, mode: 'append' } }, deps.rules ?? DEFAULT_SAFETY_RULES);
    if (verdict.ask) return skipped('safety-rules');

    const statePath = deps.store.paths.research;
    const state = readState(statePath);
    if (state.lastDigestDate === date || existsSync(digestPath)) return skipped('already-written');
    const retryMs = (deps.retryMinutes ?? DEFAULT_RETRY_MINUTES) * 60_000;
    const lastAttempt = Date.parse(state.lastAttemptAt ?? '');
    if (state.lastStatus === 'skipped' && Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < retryMs) return skipped('backoff');

    const cfg = deps.topicsConfig ?? loadResearchTopics();
    if (cfg.topics.length === 0) return skipped('no-topics');
    if (deps.registry.configuredIds().length === 0) return skipped('no-provider');

    const topics = pickTopics(cfg.topics, cfg.maxTopics, now);
    const attempt = { at: now.toISOString(), date, topics: topics.map((t) => t.id) };
    const record = (patch) => {
      const next = scrubForState({ version: RESEARCH_VERSION, ...state, lastAttemptAt: attempt.at, ...patch });
      deps.store.writeJson(statePath, next, { backup: false });
      writeResearchView(deps.store, next, now);
      return next;
    };

    let result;
    try {
      result = await deps.registry.chat(buildResearchMessages(topics, date), {
        priority: 'low',
        maxTokens: MAX_TOKENS,
        temperature: 0.3,
        maxProviders: 2,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = String(err?.failureClass ?? err?.code ?? 'provider-error');
      log.info('daily research skipped: no provider answered', { reason, error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 200) });
      record({ lastStatus: 'skipped', lastReason: reason });
      deps.events?.append('research.skipped', { date, reason, outcome: 'skipped' });
      return skipped(reason);
    }

    const body = sanitizeDigestBody(result?.text);
    if (body.length < MIN_USABLE_CHARS) {
      // Enough to tell a too-small token budget from a model that said nothing.
      const detail = { provider: result?.service ?? null, model: result?.model ?? null, chars: body.length, tokensUsed: result?.tokensUsed ?? null };
      record({ lastStatus: 'skipped', lastReason: 'empty-response', lastDetail: detail });
      deps.events?.append('research.skipped', { date, reason: 'empty-response', outcome: 'skipped', ...detail });
      return skipped('empty-response');
    }

    const provider = String(result.service ?? 'unknown');
    const model = String(result.model ?? 'unknown');
    mkdirSync(deps.store.paths.digests, { recursive: true });
    writeFileSync(digestPath, renderDigest({ date, at: attempt.at, provider, model, body }), 'utf8');
    record({ lastStatus: 'written', lastReason: null, lastDigestDate: date, lastDigestFile: `state/digests/${file}`, provider, model, topicIds: attempt.topics, preview: body.slice(0, 1200), lastDetail: null });
    deps.events?.append('research.written', { date, provider, model, topics: attempt.topics, chars: body.length, outcome: 'written' });
    log.info('daily research digest written', { date, provider, model, chars: body.length });
    return { status: 'written', reason: 'ok', date, file: `state/digests/${file}`, provider, model };
  } catch (err) {
    // Belt and braces: nothing here may fail the pulse.
    log.warn('daily research failed unexpectedly', { error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 200) });
    return skipped('error');
  }
}

/**
 * state/views/research.json — what the dashboard shows. The preview is the
 * digest itself (already scrubbed, and this repo is public anyway).
 * @param {{ writeView: Function }} store
 * @param {object} state
 * @param {Date} now
 */
function writeResearchView(store, state, now) {
  try {
    store.writeView('research.json', {
      version: RESEARCH_VERSION,
      updatedAt: now.toISOString(),
      lastAttemptAt: state.lastAttemptAt ?? null,
      lastStatus: state.lastStatus ?? null,
      lastReason: state.lastReason ?? null,
      digest: state.lastDigestDate
        ? { date: state.lastDigestDate, file: state.lastDigestFile ?? null, provider: state.provider ?? null, model: state.model ?? null, topics: state.topicIds ?? [], preview: state.preview ?? null }
        : null,
    });
  } catch (err) {
    log.warn('research view not written', { error: redactString(err instanceof Error ? err.message : String(err)).slice(0, 200) });
  }
}

export default { runDailyResearch, loadResearchTopics, pickTopics, buildResearchMessages, sanitizeDigestBody, renderDigest, researchEnabledFromEnv };
