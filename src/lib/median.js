/**
 * @file One tiny, reusable statistic — pulled out of
 * `scripts/weekly-rollup.mjs` so the weekly digest's "median pulse
 * duration" number (task instructions, section 3) is unit-testable without
 * exercising the whole script's file I/O and GitHub API calls.
 */

/**
 * @param {number[]} numbers
 * @returns {number|null} `null` for an empty input — there is no median of nothing.
 */
export function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export default median;
