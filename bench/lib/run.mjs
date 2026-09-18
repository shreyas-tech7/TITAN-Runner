/**
 * @file Spawns one real pulse process against a scratch state directory and
 * the fakes, and measures it from the outside: wall clock, exit code /
 * signal, peak RSS (sampled from /proc every few ms where available), the
 * last JSON summary line, and how many state bytes changed.
 *
 * A child process, not an in-process call, on purpose: the crash scenarios
 * SIGKILL the engine mid-flight and the only honest way to prove "nothing in
 * memory survived" is for nothing in memory to survive.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** @param {string} dir @returns {Map<string, {size:number, hash:string}>} */
export function snapshotDir(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const buf = readFileSync(full);
        out.set(relative(dir, full), { size: buf.length, hash: createHash('sha1').update(buf).digest('hex') });
      }
    }
  };
  walk(dir);
  return out;
}

/** Bytes belonging to files that were added or changed between two snapshots (a proxy for git churn). */
export function bytesChanged(before, after) {
  let bytes = 0;
  let files = 0;
  for (const [path, info] of after) {
    const prev = before.get(path);
    if (!prev || prev.hash !== info.hash) {
      bytes += info.size;
      files += 1;
    }
  }
  return { bytes, files };
}

/**
 * @param {{ repoRoot: string, stateDir: string, env: Record<string, string>, entry?: string, args?: string[], timeoutMs?: number, sampleMs?: number }} opts
 * @returns {Promise<{ exitCode: number|null, signal: string|null, wallMs: number, peakRssKb: number, summary: object|null, stdout: string, stderr: string, stateBytesChanged: number, stateFilesChanged: number }>}
 */
export function runPulseProcess(opts) {
  const entry = opts.entry ?? 'src/pulse.js';
  const before = snapshotDir(opts.stateDir);
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--max-old-space-size=256', entry, ...(opts.args ?? [])], {
      cwd: opts.repoRoot,
      env: { ...opts.env, TITAN_STATE_DIR: opts.stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let peak = 0;
    const sampler = setInterval(() => {
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const m = status.match(/VmHWM:\s+(\d+)/);
        if (m) peak = Math.max(peak, Number(m[1]));
      } catch {
        // not linux, or the process is gone
      }
    }, opts.sampleMs ?? 5);

    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);

    child.on('exit', (code, signal) => {
      clearInterval(sampler);
      clearTimeout(killer);
      const wallMs = performance.now() - started;
      const lines = stdout.trim().split('\n');
      let summary = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed && parsed.pulse === 'complete') {
            summary = parsed;
            break;
          }
        } catch {
          // not json
        }
      }
      const after = snapshotDir(opts.stateDir);
      const changed = bytesChanged(before, after);
      resolve({ exitCode: code, signal, wallMs, peakRssKb: peak, summary, stdout, stderr, stateBytesChanged: changed.bytes, stateFilesChanged: changed.files });
    });
  });
}

/** @param {string} path @returns {object[]} */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** @param {string} path */
export function readJsonOr(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** @param {string} dir @returns {number} */
export function dirBytes(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

/** @param {number[]} xs */
export function stats(xs) {
  if (xs.length === 0) return { median: null, min: null, max: null, n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { median: Math.round(median * 10) / 10, min: Math.round(sorted[0] * 10) / 10, max: Math.round(sorted[sorted.length - 1] * 10) / 10, n: sorted.length };
}
