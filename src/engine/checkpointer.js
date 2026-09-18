/**
 * @file Makes what is on disk durable. On GitHub Actions the only storage
 * that survives the job is git, so a checkpoint is a commit of `state/`
 * pushed to the branch the pulse runs on. Locally and in the harness the
 * state directory *is* the durable store (a killed process leaves its files
 * behind), so the checkpointer is a no-op and the crash tests still prove
 * what they need to.
 *
 * `TITAN_CHECKPOINT=git` (set only by the workflow) enables the git mode.
 * It commits at most once per `minIntervalMs` unless forced (end of pulse,
 * after a side effect), only when something under the state dir changed,
 * only paths under the state dir (never code), and pushes after a
 * `pull --rebase --autostash`. On a rebase conflict it aborts and builds
 * the commit differently: a temporary index is loaded from the remote tip,
 * this pulse's state directory is staged on top of it, and the resulting
 * tree is committed with the remote tip as its parent — so a file another
 * job added (a provider self-test's `providers.json`, a keepalive digest)
 * survives, a file this pulse wrote wins, and the working tree outside
 * `state/` is never touched. Three tries, then it gives up with a warning —
 * the workflow's own final commit step remains the last safety net, and
 * the next pulse recomputes from whatever landed.
 *
 * `src/pulse.js` itself still never shells out to git unless this mode is
 * on: the dry-run and the tests stay git-free.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createLogger } from '../lib/logger.js';

const log = createLogger('checkpoint');

const IDENTITY = ['-c', 'user.name=titan-runner-bot', '-c', 'user.email=titan-runner@users.noreply.github.com'];

export class Checkpointer {
  /**
   * @param {{ mode?: 'none'|'git', stateDir: string, repoRoot?: string, ref?: string, minIntervalMs?: number, now?: () => number, events?: object|null, git?: (args: string[], opts?: object) => string }} init
   */
  constructor(init) {
    this.mode = init.mode ?? 'none';
    this.stateDir = init.stateDir;
    this.repoRoot = init.repoRoot ?? process.cwd();
    this.ref = init.ref ?? process.env.GITHUB_REF_NAME ?? 'main';
    this.minIntervalMs = init.minIntervalMs ?? 20_000;
    this.now = init.now ?? (() => Date.now());
    this.events = init.events ?? null;
    this.lastCommitAt = 0;
    this.commits = 0;
    this.pushes = 0;
    this.failures = 0;
    this.git = init.git ?? ((args, opts = {}) => execFileSync('git', args, { cwd: this.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim());
    const rel = relative(this.repoRoot, this.stateDir);
    this.stateRel = rel;
    if (this.mode === 'git' && (rel.startsWith('..') || isAbsolute(rel) || rel.length === 0)) {
      log.warn('checkpoint mode git requested but the state dir is not inside the repo; falling back to none', { stateDir: this.stateDir });
      this.mode = 'none';
    }
  }

  /**
   * @param {string} reason
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ committed: boolean, pushed: boolean, skipped?: string }>}
   */
  async checkpoint(reason, opts = {}) {
    if (this.mode !== 'git') return { committed: false, pushed: false, skipped: 'mode none' };
    const force = opts.force ?? false;
    if (!force && this.now() - this.lastCommitAt < this.minIntervalMs) return { committed: false, pushed: false, skipped: 'rate limited' };

    const started = this.now();
    try {
      this.git(['add', '-A', '--', this.stateRel]);
      const staged = this.git(['diff', '--cached', '--name-only', '--', this.stateRel]);
      if (!staged) return { committed: false, pushed: false, skipped: 'nothing changed' };
      this.git([...IDENTITY, 'commit', '-q', '-m', `chore(state): checkpoint ${reason} ${new Date(this.now()).toISOString()}`]);
      this.commits += 1;
      this.lastCommitAt = this.now();
    } catch (err) {
      this.failures += 1;
      log.warn('checkpoint commit failed', { reason, error: String(err).slice(0, 300) });
      this.events?.append('checkpoint.failed', { reason, stage: 'commit', outcome: 'error' });
      return { committed: false, pushed: false, skipped: 'commit failed' };
    }

    const pushed = this.#pushWithRetry(reason);
    this.events?.append('checkpoint.written', { reason, outcome: pushed ? 'pushed' : 'committed-only', durationMs: this.now() - started });
    return { committed: true, pushed };
  }

  #pushWithRetry(reason) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        try {
          this.git(['pull', '--rebase', '--autostash', '--quiet', 'origin', this.ref]);
        } catch {
          try {
            this.git(['rebase', '--abort']);
          } catch {
            // nothing to abort
          }
          this.#reapplyOnRemote(reason);
        }
        this.git(['push', '--quiet', 'origin', `HEAD:${this.ref}`]);
        this.pushes += 1;
        return true;
      } catch (err) {
        this.failures += 1;
        log.warn('checkpoint push failed', { attempt, error: String(err).slice(0, 300) });
        if (attempt < 3) sleepSync(500 * attempt);
      }
    }
    this.events?.append('checkpoint.failed', { reason, stage: 'push', outcome: 'error' });
    return false;
  }

  /**
   * Build a commit on top of the remote tip from a temporary index: the
   * remote's tree plus this pulse's state directory as it is on disk. Then
   * move the branch there and sync only `state/` in the working tree, so
   * files another job added under `state/` reappear locally and nothing
   * outside `state/` is touched.
   */
  #reapplyOnRemote(reason) {
    this.git(['fetch', '--quiet', 'origin', this.ref]);
    const remoteTip = this.git(['rev-parse', `origin/${this.ref}`]);
    const scratch = mkdtempSync(join(tmpdir(), 'titan-index-'));
    const tmpIndex = join(scratch, 'index');
    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      this.git(['read-tree', remoteTip], { env });
      // Deletions this pulse made on purpose (a finished checkpoint, a
      // released lease) are files that were in OUR head but are gone from
      // the working tree; a file only the remote added must not be deleted
      // just because we never had it. So: stage our removals explicitly,
      // then add without staging removals.
      const oursBefore = this.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', this.stateRel]).split('\n').filter(Boolean);
      const inRemote = new Set(this.git(['ls-tree', '-r', '--name-only', remoteTip, '--', this.stateRel]).split('\n').filter(Boolean));
      const missing = this.git(['ls-files', '--deleted', '--', this.stateRel]).split('\n').filter(Boolean);
      const removed = oursBefore.filter((f) => missing.includes(f) && inRemote.has(f));
      if (removed.length > 0) this.git(['rm', '-q', '--cached', '--', ...removed], { env });
      this.git(['add', '--ignore-removal', '--', this.stateRel], { env });
      const tree = this.git(['write-tree'], { env });
      const remoteTree = this.git(['rev-parse', `${remoteTip}^{tree}`]);
      let target = remoteTip;
      if (tree !== remoteTree) {
        target = this.git([...IDENTITY, 'commit-tree', tree, '-p', remoteTip, '-m', `chore(state): checkpoint ${reason} (re-applied after conflict)`]);
      }
      this.git(['reset', '-q', '--soft', target]);
      this.git(['reset', '-q']);
      this.git(['checkout', '-q', '--', this.stateRel]);
      this.events?.append('checkpoint.conflict-resolved', { reason, outcome: tree !== remoteTree ? 'reapplied' : 'remote-already-current' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  summary() {
    return { mode: this.mode, commits: this.commits, pushes: this.pushes, failures: this.failures };
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // A short, deliberate busy wait inside a git retry — never on the hot path.
  }
}

export function checkpointModeFromEnv(env = process.env) {
  return env.TITAN_CHECKPOINT === 'git' ? 'git' : 'none';
}

export default Checkpointer;
