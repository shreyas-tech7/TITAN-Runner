/**
 * @file Lean provider contract for the five free-tier chat providers
 * (Groq, Together, OpenRouter, Gemini, HuggingFace).
 *
 * This is a deliberately smaller rewrite of TITAN's original
 * `backend/services/base.js` for a stateless, infrequent caller: a pulse
 * claims at most a handful of tasks every ~15 minutes, so the original's
 * per-provider circuit breaker, sliding quota tracker, and health-check
 * ring buffer are complexity this repo does not need to carry or maintain.
 * What's kept, because it matters even for a low-volume caller: the
 * not-configured short circuit, a hard per-call deadline, retry with full
 * jitter on 429/5xx/network faults (`lib/retry.js`, ported unchanged), and
 * redacting anything upstream before it can reach a log line or state file.
 *
 * Subclasses override `_doChat`, never `chat`.
 */
import { config } from '../config.js';
import { RetryableError, isRetryableError, withRetry } from '../lib/retry.js';
import { redactString } from '../lib/redact.js';
import { Semaphore } from '../lib/semaphore.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('providers:base');

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PER_PROVIDER = 4;
const MAX_UPSTREAM_MESSAGE = 200;

export class ProviderError extends Error {
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.code = opts.code ?? 'UPSTREAM_ERROR';
    this.status = opts.status ?? null;
    this.service = opts.service ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

async function safeUpstreamMessage(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    return '';
  }
  if (!raw) return '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  const candidates = [];
  if (parsed && typeof parsed === 'object') {
    const err = parsed.error;
    if (typeof err === 'string') candidates.push(err);
    else if (err && typeof err === 'object') candidates.push(err.message, err.code, err.type);
    candidates.push(parsed.message, parsed.detail);
  }
  const picked = candidates.find((c) => typeof c === 'string' && c.trim().length > 0);
  if (!picked) return '';
  return String(picked).replace(/\s+/g, ' ').trim().slice(0, MAX_UPSTREAM_MESSAGE);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function stampRetryable(err, service, code, status, retryAfterMs) {
  return Object.assign(err, { service, code, status, retryAfterMs, retryable: true });
}

/** @param {Response} res @param {{service: string, label: string}} ctx */
export async function upstreamErrorFrom(res, ctx) {
  const detail = await safeUpstreamMessage(res);
  const suffix = detail ? `: ${detail}` : '';
  const status = res.status;
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));

  if (status === 429) {
    const err = new RetryableError(`${ctx.label} rate limited (429)${suffix}`, { status, retryAfterMs: retryAfterMs ?? undefined });
    return stampRetryable(err, ctx.service, 'RATE_LIMITED', status, retryAfterMs);
  }
  if (status >= 500) {
    const err = new RetryableError(`${ctx.label} upstream error (${status})${suffix}`, { status, retryAfterMs: retryAfterMs ?? undefined });
    return stampRetryable(err, ctx.service, 'UPSTREAM_ERROR', status, retryAfterMs);
  }
  const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : 'UPSTREAM_ERROR';
  return new ProviderError(`${ctx.label} rejected the request (${status})${suffix}`, {
    code, status, service: ctx.service, retryable: false,
  });
}

/** @param {string} message @param {{service:string,status?:number|null,retryAfterMs?:number|null,code?:string,cause?:unknown}} opts */
export function retryableErrorFrom(message, opts) {
  const err = new RetryableError(message, {
    status: opts.status ?? undefined,
    retryAfterMs: opts.retryAfterMs ?? undefined,
    cause: opts.cause,
  });
  return stampRetryable(err, opts.service, opts.code ?? 'UPSTREAM_ERROR', opts.status ?? null, opts.retryAfterMs ?? null);
}

/** @param {unknown} cause @param {{service:string,label:string}} ctx */
export function networkErrorFrom(cause, ctx) {
  const reason = cause instanceof Error ? cause.message : 'network failure';
  const err = new RetryableError(`${ctx.label} unreachable: ${reason}`, { cause });
  return stampRetryable(err, ctx.service, 'UPSTREAM_ERROR', null, null);
}

export function openAiChatBody(messages, model, opts = {}) {
  return {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 1024,
    stream: false,
  };
}

export async function readJsonResponse(res, ctx) {
  try {
    return await res.json();
  } catch (err) {
    const wrapped = new RetryableError(`${ctx.label} returned a malformed or truncated response body`, { cause: err });
    throw stampRetryable(wrapped, ctx.service, 'UPSTREAM_ERROR', res.status ?? null, null);
  }
}

export function parseOpenAiChat(json, ctx) {
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new ProviderError(`${ctx.label} returned no message content`, {
      code: 'UPSTREAM_ERROR', service: ctx.service, retryable: false,
    });
  }
  const tokens = json?.usage?.total_tokens;
  return { text, model: typeof json?.model === 'string' ? json.model : ctx.model, tokensUsed: Number.isFinite(tokens) ? Number(tokens) : null };
}

export class BaseProvider {
  #gate;

  constructor(init) {
    if (new.target === BaseProvider) {
      throw new TypeError('BaseProvider is abstract; extend it with a concrete provider.');
    }
    this.id = init.id;
    this.label = init.label;
    this.apiKey = init.apiKey || null;
    this.model = init.model || '';
    this.#gate = new Semaphore(MAX_CONCURRENT_PER_PROVIDER);
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * @param {{role:string,content:string}[]} messages
   * @param {{temperature?:number,maxTokens?:number,signal?:AbortSignal}} [opts]
   * @returns {Promise<{text:string,service:string,model:string,latencyMs:number,tokensUsed:number|null,attempts:number}>}
   */
  async chat(messages, opts = {}) {
    if (!this.isConfigured()) {
      throw new ProviderError(`${this.label} is not configured (missing API key)`, {
        code: 'NOT_CONFIGURED', service: this.id, retryable: false,
      });
    }

    await this.#gate.acquire();
    const started = performance.now();
    let attempts = 1;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`deadline of ${REQUEST_TIMEOUT_MS}ms exceeded`)), REQUEST_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;

      let raw;
      try {
        raw = await withRetry(() => this._doChat(messages, opts, signal), {
          attempts: 3,
          baseDelayMs: 300,
          maxDelayMs: 8000,
          signal,
          isRetryable: isRetryableError,
          onRetry: (info) => {
            attempts += 1;
            log.debug('retrying provider call', { service: this.id, attempt: attempts, error: redactString(String(info.error)) });
          },
        });
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Math.round(performance.now() - started);
      return {
        text: raw.text,
        service: this.id,
        model: raw.model || this.model,
        latencyMs,
        tokensUsed: raw.tokensUsed ?? null,
        attempts,
      };
    } finally {
      this.#gate.release();
    }
  }

  /** @param {{role:string,content:string}[]} _messages @param {object} _opts @param {AbortSignal} _signal */
  async _doChat(_messages, _opts, _signal) {
    throw new Error(`${this.id}: _doChat() is not implemented`);
  }
}

export default BaseProvider;
