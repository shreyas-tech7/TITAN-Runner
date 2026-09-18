/**
 * @file A tiny seeded PRNG (mulberry32) so a simulated run is reproducible
 * from its seed: same seed, same fake latencies, same fault order. Not for
 * anything security-relevant — `node:crypto` is used for ids and keys.
 */

/**
 * @param {number} seed Any 32-bit integer.
 * @returns {() => number} Uniform in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {() => number} rng
 * @param {number|[number, number]} range A fixed value or an inclusive [min, max] pair.
 * @returns {number}
 */
export function pick(rng, range) {
  if (Array.isArray(range)) {
    const [min, max] = range;
    return Math.round(min + rng() * Math.max(0, max - min));
  }
  return Number(range) || 0;
}

export default { mulberry32, pick };
