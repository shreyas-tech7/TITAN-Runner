/**
 * @file Reports every provider call to the Worker in batches (RO1, contract v1).
 *
 * During a pulse the router calls `record()` after each attempt. At the end of the pulse `flush()` sends one batch to
 * `POST /ops/usage`. The ops token goes in the Authorization header. A batch holds one record for each provider, model,
 * and status, so a pulse writes a few rows and not one for each call.
 *
 * The record carries a provider name, a model name, counts, a status, and a time. It never carries a prompt, an
 * answer, or a key. If `TITAN_WORKER_URL` or `OPS_TOKEN` is not set, the reporter does nothing.
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('ops:usage');
const MAX_RECORDS = 200;

/** @param {string} id A registry id. A custom slot keeps its id, such as custom_1. */
const providerName = (id) => String(id).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);
const modelName = (m) => (typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(m) ? m : '*');

export class UsageReporter {
  /**
   * @param {{ workerUrl?: string, token?: string, fetchImpl?: typeof fetch, now?: () => Date, source?: 'runner'|'titan', events?: { append: Function }|null }} [opts]
   */
  constructor(opts = {}) {
    this.workerUrl = (opts.workerUrl ?? process.env.TITAN_WORKER_URL ?? '').replace(/\/$/, '');
    this.token = opts.token ?? process.env.OPS_TOKEN ?? '';
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.now = opts.now ?? (() => new Date());
    this.source = opts.source ?? 'runner';
    this.events = opts.events ?? null;
    /** @type {Map<string, object>} */
    this.pending = new Map();
    this.sent = 0;
    this.dropped = 0;
  }

  get enabled() {
    return Boolean(this.workerUrl && this.token);
  }

  /**
   * Count one call.
   * @param {{ provider: string, model?: string|null, status: 'ok'|'error'|'rate_limited', tokensIn?: number|null, tokensOut?: number|null, remainingRequests?: number|null, remainingTokens?: number|null }} call
   */
  record(call) {
    const provider = providerName(call.provider);
    const model = modelName(call.model);
    const key = `${provider}\u0000${model}\u0000${call.status}`;
    const cur = this.pending.get(key) ?? { source: this.source, provider, model, requests: 0, tokens_in: 0, tokens_out: 0, status: call.status, ts: this.now().toISOString() };
    cur.requests += 1;
    cur.tokens_in += Math.max(0, Math.round(call.tokensIn ?? 0));
    cur.tokens_out += Math.max(0, Math.round(call.tokensOut ?? 0));
    cur.ts = this.now().toISOString();
    // The last header values of the batch show what the provider says is left.
    if (Number.isInteger(call.remainingRequests) && call.remainingRequests >= 0) cur.remaining_requests = call.remainingRequests;
    if (Number.isInteger(call.remainingTokens) && call.remainingTokens >= 0) cur.remaining_tokens = call.remainingTokens;
    this.pending.set(key, cur);
  }

  /** The records that wait to be sent. */
  batch() {
    return [...this.pending.values()].slice(0, MAX_RECORDS);
  }

  /**
   * Send the batch. Never throws. Two tries, then the batch is dropped and an event says so.
   * @returns {Promise<{ sent: number, dropped: number, skipped?: string }>}
   */
  async flush() {
    const batch = this.batch();
    if (batch.length === 0) return { sent: 0, dropped: 0 };
    if (!this.enabled) {
      this.pending.clear();
      return { sent: 0, dropped: 0, skipped: 'TITAN_WORKER_URL or OPS_TOKEN is not set' };
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await this.fetchImpl(`${this.workerUrl}/ops/usage`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(6_000),
        });
        if (res.ok) {
          this.pending.clear();
          this.sent += batch.length;
          this.events?.append('ops.usage.sent', { count: batch.length, outcome: 'ok' });
          return { sent: batch.length, dropped: 0 };
        }
        // A 4xx will not get better on a retry. Drop the batch and say why, with the status only.
        if (res.status >= 400 && res.status < 500) {
          this.#drop(batch, `HTTP ${res.status}`);
          return { sent: 0, dropped: batch.length };
        }
      } catch (err) {
        log.debug('usage batch attempt failed', { attempt, error: err instanceof Error ? err.message.slice(0, 120) : 'error' });
      }
    }
    this.#drop(batch, 'the Worker was not reachable');
    return { sent: 0, dropped: batch.length };
  }

  #drop(batch, reason) {
    this.pending.clear();
    this.dropped += batch.length;
    log.warn('usage batch dropped', { count: batch.length, reason });
    this.events?.append('ops.usage.dropped', { count: batch.length, reason, outcome: 'dropped' });
  }
}

export default UsageReporter;
