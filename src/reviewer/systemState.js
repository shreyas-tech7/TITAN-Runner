/**
 * @file A cheap, best-effort snapshot of "what's going on right now" for the
 * Reviewer Gate's Layer 2 prompt — active branch and whether the tree is
 * dirty. Two local `git` calls, no network. Simplified from TITAN's original
 * `backend/lib/reviewer/systemState.js`: this process always runs from the
 * repo root (a fresh GitHub Actions checkout, or a contributor's own clone),
 * so there is no separate backend-subdirectory path to resolve up from.
 */
import { execFileSync } from 'node:child_process';

const CACHE_TTL_MS = 15_000;
let cache = null;

function readGitState() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 2000,
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 2000,
    });
    return { branch: branch || null, dirty: status.trim().length > 0, note: 'branch + dirty status only' };
  } catch {
    return { branch: null, dirty: null, note: 'git unavailable' };
  }
}

export function getSystemStateSnapshot(opts = {}) {
  const now = opts.now ?? Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const value = readGitState();
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export function __resetSystemStateCacheForTests() {
  cache = null;
}

export default { getSystemStateSnapshot, __resetSystemStateCacheForTests };
