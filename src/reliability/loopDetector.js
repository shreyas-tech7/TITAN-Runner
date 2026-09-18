/**
 * @file Loop and no-progress detection. An autonomous loop that keeps doing
 * the same thing — the same tool call with the same arguments, the same
 * failure with the same message, the same step output — is not making
 * progress and will not start; it is burning quota. The detector counts
 * repeats of a signature and reports `looping` once a signature has been
 * seen `maxRepeats` times. Signatures are short hashes, so the record
 * carries no content.
 */
import { createHash } from 'node:crypto';

/** @param {unknown} value @returns {string} 12-hex signature of a JSON-stable rendering. */
export function fingerprint(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(sortKeys(value));
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export class LoopDetector {
  /** @param {{ maxRepeats?: number, noProgressLimit?: number }} [init] */
  constructor(init = {}) {
    this.maxRepeats = init.maxRepeats ?? 3;
    this.noProgressLimit = init.noProgressLimit ?? 6;
    /** @type {Map<string, number>} */
    this.counts = new Map();
    this.noProgress = 0;
    this.total = 0;
  }

  /**
   * @param {unknown} value Anything describing what just happened.
   * @param {{ progress?: boolean }} [opts] `progress: false` marks an
   *   observation that moved nothing forward (a failure, a repeated read).
   * @returns {{ signature: string, repeats: number, looping: boolean, stalled: boolean }}
   */
  observe(value, opts = {}) {
    const signature = fingerprint(value);
    const repeats = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, repeats);
    this.total += 1;
    if (opts.progress === false) this.noProgress += 1;
    else if (opts.progress === true) this.noProgress = 0;
    return { signature, repeats, looping: repeats >= this.maxRepeats, stalled: this.noProgress >= this.noProgressLimit };
  }

  snapshot() {
    return { observations: this.total, distinct: this.counts.size, noProgress: this.noProgress };
  }
}

export default LoopDetector;
