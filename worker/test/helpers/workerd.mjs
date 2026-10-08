// Starts the real Worker in the real workerd runtime through `wrangler dev --local` and stops it again.
// Tests that need the true Workers runtime (the sealed box, the CPU cost, the MCP route) use this helper.
// It binds 127.0.0.1 only, uses a throwaway local D1 under a temp folder, and always kills its process group.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * @param {{ port?: number, vars?: Record<string,string>, timeoutMs?: number }} [opts]
 * @returns {Promise<{ url: string, stop: () => Promise<void>, logs: () => string, persist: string }>}
 */
export async function startWorkerd(opts = {}) {
  const port = opts.port ?? 8780 + Math.floor(Math.random() * 100);
  const persist = mkdtempSync(join(tmpdir(), 'titan-workerd-'));
  const devVars = join(persist, '.dev.vars');
  // dotenv keeps a single quoted value as it is. A JSON value has double quotes and no single quote.
  const quote = (v) => (String(v).includes('"') && !String(v).includes("'") ? `'${v}'` : JSON.stringify(String(v)));
  const lines = Object.entries(opts.vars ?? {}).map(([k, v]) => `${k}=${quote(v)}`);
  writeFileSync(devVars, `${lines.join('\n')}\n`);
  const args = ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--env-file', devVars, '--log-level', 'info'];
  const child = spawn('npx', args, { cwd: WORKER_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 400));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(persist, { recursive: true, force: true });
  };
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { await stop(); throw new Error(`wrangler dev exited early:\n${log.slice(-1500)}`); }
    try {
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { url, stop, logs: () => log, persist };
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = log.slice(-1500);
  await stop();
  throw new Error(`wrangler dev did not become ready in time:\n${tail}`);
}
