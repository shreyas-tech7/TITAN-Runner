/**
 * @file The engine's clock. Every timer the engine keeps across pulses —
 * lease expiry, wake-up times, breaker cooldowns, quota windows — reads
 * through here so a simulation can move time forward between pulses the
 * way the cron does in production (the harness runs its pulses back to
 * back; a real cron leaves fifteen minutes between them).
 *
 * `TITAN_CLOCK_OFFSET_MS` is honoured only while the fakes are wired
 * (`TITAN_FAKE_PROVIDER` / `TITAN_FAKE_GITHUB` set): a production pulse can
 * not be moved off the wall clock by an environment variable.
 */

/** @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function clockOffsetMs(env = process.env) {
  if (!env.TITAN_FAKE_PROVIDER && !env.TITAN_FAKE_GITHUB) return 0;
  const n = Number.parseInt(String(env.TITAN_CLOCK_OFFSET_MS ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Milliseconds since the epoch, offset-aware. */
export function nowMs() {
  return Date.now() + clockOffsetMs();
}

/** The current time as a Date, offset-aware. */
export function now() {
  return new Date(nowMs());
}

export default { now, nowMs, clockOffsetMs };
