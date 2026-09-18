/**
 * @file The durable state store: every committed JSON file goes through
 * here. Reads validate against the schema (`state/schema.js`) and migrate
 * older versions; a file that will not parse or validate is not silently
 * replaced with an empty default (which is what `io.js#readJson` did — the
 * queue would vanish) but repaired from the last good backup, with the
 * corrupt bytes set aside for a human and an event on the record. Writes
 * are atomic (temp + rename), validated before they land, skipped when the
 * content did not change (an idle pulse must not churn git history), and
 * followed by a backup copy of the previous good version for the files
 * that matter (the queue, control, checkpoints).
 *
 * Nothing here touches git. `engine/checkpointer.js` decides when what is
 * on disk becomes a commit.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { check } from '../lib/validate.js';
import { scrubForState } from '../lib/secretScrub.js';
import { createLogger } from '../lib/logger.js';
import { statePaths } from './paths.js';
import {
  TASKS_FILE_SCHEMA, HEARTBEAT_SCHEMA, CONTROL_SCHEMA, CHECKPOINT_SCHEMA,
  TASKS_SCHEMA_VERSION, migrateTasks,
} from './schema.js';

const log = createLogger('state:store');

export const CONTROL_VERSION = 1;

/** @returns {object} */
export function defaultTasksFile(now = new Date()) {
  return { version: TASKS_SCHEMA_VERSION, updatedAt: now.toISOString(), tasks: [] };
}

/** @returns {object} */
export function defaultControl(now = new Date()) {
  return { version: CONTROL_VERSION, killSwitch: false, drain: false, safeMode: false, autonomy: 'autonomous', updatedAt: now.toISOString(), updatedBy: null, reason: null };
}

export function defaultHeartbeat() {
  return {
    version: 1,
    lastPulseAt: null,
    lastPulseStatus: null,
    lastPulseDurationMs: null,
    lastPulseTasksClaimed: 0,
    lastPulseTasksCompleted: 0,
    lastPulseTasksFailed: 0,
    lastPulseError: null,
    consecutivePulseFailures: 0,
    totalPulses: 0,
    cadenceMinutes: 15,
  };
}

/** Files whose previous good version is kept under state/backup/. */
const BACKED_UP = new Set(['tasks.json', 'control.json']);

export class StateStore {
  /**
   * @param {{ stateDir?: string, now?: () => Date, events?: { append: Function } | null }} [init]
   */
  constructor(init = {}) {
    this.paths = statePaths(init.stateDir);
    this.now = init.now ?? (() => new Date());
    this.events = init.events ?? null;
    this.backupDir = join(this.paths.stateDir, 'backup');
    this.quarantineDir = join(this.paths.stateDir, 'quarantine');
    this.checkpointsDir = join(this.paths.stateDir, 'checkpoints');
    this.leasesDir = join(this.paths.stateDir, 'leases');
    this.eventsDir = join(this.paths.stateDir, 'events');
    this.archiveDir = join(this.paths.stateDir, 'archive');
    this.viewsDir = join(this.paths.stateDir, 'views');
    this.controlPath = join(this.paths.stateDir, 'control.json');
    /** @type {Set<string>} Paths this store wrote during the process — what a checkpoint commits. */
    this.written = new Set();
    /** @type {Array<{file: string, reason: string, repairedFrom: string|null}>} */
    this.repairs = [];
  }

  ensureLayout() {
    for (const dir of [this.paths.stateDir, this.paths.runs, this.paths.digests, this.paths.reviews, this.checkpointsDir, this.leasesDir, this.eventsDir, this.backupDir, this.viewsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.paths.tasks)) this.writeJson(this.paths.tasks, defaultTasksFile(this.now()));
    if (!existsSync(this.paths.heartbeat)) this.writeJson(this.paths.heartbeat, defaultHeartbeat());
    if (!existsSync(this.paths.agents)) this.writeJson(this.paths.agents, {});
    if (!existsSync(this.controlPath)) this.writeJson(this.controlPath, defaultControl(this.now()));
  }

  /* ---- generic read/write ------------------------------------------------ */

  /**
   * Parse + validate one file, repairing from backup when it is corrupt.
   * @param {string} path
   * @param {object|null} schema
   * @param {() => object} fallback
   * @param {{ migrate?: (raw: object) => { file: object, migrated: boolean, from: number } }} [opts]
   * @returns {object}
   */
  readValidated(path, schema, fallback, opts = {}) {
    const name = basename(path);
    const attempt = (source, text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return { ok: false, reason: `parse error: ${err.message}`.slice(0, 200) };
      }
      let migrated = false;
      let from = null;
      if (opts.migrate) {
        const m = opts.migrate(parsed);
        parsed = m.file;
        migrated = m.migrated;
        from = m.from;
      }
      if (schema) {
        const result = check(parsed, schema);
        if (!result.ok) return { ok: false, reason: `schema: ${result.errors.slice(0, 3).join('; ')}`.slice(0, 300) };
      }
      return { ok: true, value: parsed, migrated, from, source };
    };

    if (!existsSync(path)) return fallback();
    const primary = attempt('primary', readFileSync(path, 'utf8'));
    if (primary.ok) {
      if (primary.migrated) {
        log.info('migrated state file', { file: name, from: primary.from, to: primary.value.version });
        this.events?.append('state.migrated', { file: name, from: primary.from, to: primary.value.version });
      }
      return primary.value;
    }

    // Corrupt. Set the bytes aside, then try the backup.
    log.error('state file corrupt', { file: name, reason: primary.reason });
    this.quarantine(path, primary.reason);
    const backupPath = join(this.backupDir, name);
    if (existsSync(backupPath)) {
      const backup = attempt('backup', readFileSync(backupPath, 'utf8'));
      if (backup.ok) {
        log.warn('repaired state file from backup', { file: name });
        this.repairs.push({ file: name, reason: primary.reason, repairedFrom: 'backup' });
        this.events?.append('state.repaired', { file: name, reason: primary.reason, from: 'backup' });
        return backup.value;
      }
    }
    this.repairs.push({ file: name, reason: primary.reason, repairedFrom: null });
    this.events?.append('state.repaired', { file: name, reason: primary.reason, from: 'default' });
    return fallback();
  }

  quarantine(path, reason) {
    try {
      mkdirSync(this.quarantineDir, { recursive: true });
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const target = join(this.quarantineDir, `${basename(path)}.${stamp}.corrupt`);
      copyFileSync(path, target);
      writeFileSync(`${target}.reason.txt`, `${reason}\n`);
    } catch (err) {
      log.warn('could not quarantine corrupt file', { path, error: String(err) });
    }
  }

  /**
   * Atomic write; skips when unchanged; keeps a backup of the previous good
   * version for the files that matter.
   * @param {string} path
   * @param {unknown} data
   * @param {{ schema?: object, backup?: boolean, scrub?: boolean }} [opts]
   * @returns {boolean} Whether anything was written.
   */
  writeJson(path, data, opts = {}) {
    const payload = opts.scrub === false ? data : scrubForState(data);
    if (opts.schema) {
      const result = check(payload, opts.schema);
      if (!result.ok) throw new Error(`refusing to write invalid ${basename(path)}: ${result.errors.slice(0, 3).join('; ')}`);
    }
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      let current = null;
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = null;
      }
      if (current === text) return false;
      if (opts.backup ?? BACKED_UP.has(basename(path))) {
        try {
          mkdirSync(this.backupDir, { recursive: true });
          copyFileSync(path, join(this.backupDir, basename(path)));
        } catch (err) {
          log.warn('backup copy failed', { path, error: String(err) });
        }
      }
    }
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    this.written.add(path);
    return true;
  }

  /* ---- typed accessors --------------------------------------------------- */

  loadTasks() {
    const file = this.readValidated(this.paths.tasks, TASKS_FILE_SCHEMA, () => defaultTasksFile(this.now()), { migrate: (raw) => migrateTasks(raw) });
    // Remember the exact bytes we loaded (or repaired to) so a later save can
    // tell our own writes apart from another process's.
    this.tasksTextBaseline = existsSync(this.paths.tasks) ? readFileSync(this.paths.tasks, 'utf8') : null;
    return file;
  }

  /**
   * Save the queue. Only bumps `updatedAt` when the task list itself
   * changed (an idle pulse must not rewrite and re-commit the queue), and
   * when `loadedSnapshot` is given, merges by ownership against whatever
   * is on disk now: a task this pulse changed keeps our version, any other
   * task keeps the on-disk version. That is what stops two overlapping
   * pulses from clobbering each other — the one that skipped a leased task
   * must not write its stale copy of it back over the owner's result.
   * @param {object} file
   * @param {{ loadedSnapshot?: string|null, ownedIds?: Iterable<string> }} [opts]
   *   `loadedSnapshot` is `JSON.stringify(file.tasks)` as loaded; `ownedIds`
   *   are the tasks this pulse leased (their version always wins).
   * @returns {boolean} written
   */
  saveTasks(file, opts = {}) {
    let candidate = { ...file, version: TASKS_SCHEMA_VERSION };
    const previous = existsSync(this.paths.tasks) ? readFileSync(this.paths.tasks, 'utf8') : null;
    // Foreign write detection: the file on disk is neither what we loaded
    // nor what we last wrote, so another process changed it underneath us.
    const foreign = opts.loadedSnapshot != null && previous != null && previous !== this.tasksTextBaseline;
    if (foreign) {
      const onDisk = this.readValidated(this.paths.tasks, TASKS_FILE_SCHEMA, () => null, { migrate: (raw) => migrateTasks(raw) });
      if (onDisk && JSON.stringify(onDisk.tasks) !== opts.loadedSnapshot) {
        candidate = { ...candidate, tasks: mergeTasksByOwnership(file.tasks, onDisk.tasks, opts.loadedSnapshot, opts.ownedIds ?? []) };
        file.tasks = candidate.tasks;
        this.events?.append('state.merged', { file: 'tasks.json', outcome: 'ownership-merge', owned: [...(opts.ownedIds ?? [])] });
      }
    }
    const text = `${JSON.stringify(scrubForState(candidate), null, 2)}\n`;
    const same = previous != null && stripUpdatedAt(previous) === stripUpdatedAt(text);
    if (same) return false;
    const written = this.writeJson(this.paths.tasks, { ...candidate, updatedAt: this.now().toISOString() }, { schema: TASKS_FILE_SCHEMA });
    if (written) this.tasksTextBaseline = readFileSync(this.paths.tasks, 'utf8');
    return written;
  }

  /**
   * Retention for the queue: terminal tasks older than `maxAgeDays` move to
   * `state/archive/tasks-<YYYY-MM>.jsonl` (append-only, one line each) so
   * `tasks.json` stays a working set instead of every task ever seen.
   * @param {object} file mutated
   * @param {{ maxAgeDays?: number, keepMin?: number }} [opts]
   * @returns {number} archived count
   */
  archiveOldTasks(file, opts = {}) {
    const maxAgeMs = (opts.maxAgeDays ?? 30) * 86_400_000;
    const keepMin = opts.keepMin ?? 20;
    const nowMs = this.now().getTime();
    const terminal = new Set(['complete', 'failed', 'blocked', 'cancelled', 'expired', 'dead-lettered']);
    const keep = [];
    const archive = [];
    for (const t of file.tasks) {
      const done = Date.parse(t.completedAt ?? '');
      if (terminal.has(t.status) && Number.isFinite(done) && nowMs - done > maxAgeMs) archive.push(t);
      else keep.push(t);
    }
    if (archive.length === 0 || file.tasks.length - archive.length < keepMin) return 0;
    mkdirSync(this.archiveDir, { recursive: true });
    const byMonth = new Map();
    for (const t of archive) {
      const month = String(t.completedAt).slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), t]);
    }
    for (const [month, rows] of byMonth) {
      const path = join(this.archiveDir, `tasks-${month}.jsonl`);
      const lines = rows.map((t) => JSON.stringify(scrubForState(t))).join('\n');
      writeFileSync(path, `${existsSync(path) ? readFileSync(path, 'utf8') : ''}${lines}\n`);
      this.written.add(path);
    }
    file.tasks = keep;
    return archive.length;
  }

  loadHeartbeat() {
    return this.readValidated(this.paths.heartbeat, HEARTBEAT_SCHEMA, () => defaultHeartbeat());
  }

  saveHeartbeat(hb) {
    return this.writeJson(this.paths.heartbeat, hb, { schema: HEARTBEAT_SCHEMA });
  }

  loadControl() {
    return this.readValidated(this.controlPath, CONTROL_SCHEMA, () => defaultControl(this.now()));
  }

  saveControl(control) {
    return this.writeJson(this.controlPath, { ...control, version: CONTROL_VERSION }, { schema: CONTROL_SCHEMA });
  }

  /* ---- checkpoints ------------------------------------------------------- */

  checkpointPath(taskId) {
    return join(this.checkpointsDir, `${safeName(taskId)}.json`);
  }

  loadCheckpoint(taskId) {
    const path = this.checkpointPath(taskId);
    if (!existsSync(path)) return null;
    return this.readValidated(path, CHECKPOINT_SCHEMA, () => null);
  }

  saveCheckpoint(cp) {
    return this.writeJson(this.checkpointPath(cp.taskId), { ...cp, version: 1, updatedAt: this.now().toISOString() }, { schema: CHECKPOINT_SCHEMA, backup: false });
  }

  deleteCheckpoint(taskId) {
    const path = this.checkpointPath(taskId);
    if (existsSync(path)) {
      unlinkSync(path);
      this.written.add(path);
    }
  }

  listCheckpoints() {
    if (!existsSync(this.checkpointsDir)) return [];
    return readdirSync(this.checkpointsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  }

  /* ---- views ------------------------------------------------------------- */

  /**
   * A view is rewritten only when something other than its `updatedAt`
   * changed: an idle pulse must not churn three files (and three commits'
   * worth of blobs) just to move a timestamp.
   */
  writeView(name, data) {
    const path = join(this.viewsDir, name);
    if (existsSync(path)) {
      try {
        const current = readFileSync(path, 'utf8');
        const next = `${JSON.stringify(scrubForState(data), null, 2)}\n`;
        if (stripUpdatedAt(current) === stripUpdatedAt(next)) return false;
      } catch {
        // unreadable: rewrite it
      }
    }
    return this.writeJson(path, data, { backup: false });
  }
}

function stripUpdatedAt(text) {
  return text.replace(/"updatedAt": "[^"]*"/, '"updatedAt": ""');
}

/**
 * Merge our in-memory queue with a queue another process wrote meanwhile.
 * The lease is the authority: a task this pulse leased (`ownedIds`) keeps
 * our version. Any other task keeps our version only if nobody else moved
 * it since we loaded it (on-disk == loaded); if someone did, theirs wins
 * and our stale copy is dropped — the other pulse holds (or held) the
 * lease, so it knows more than we do. Tasks only we have are appended.
 * Order: on-disk order first, then our additions.
 * @param {object[]} ours
 * @param {object[]} theirs
 * @param {string} loadedSnapshot JSON of `ours` as loaded.
 * @param {Iterable<string>} [ownedIds]
 */
export function mergeTasksByOwnership(ours, theirs, loadedSnapshot, ownedIds = []) {
  let loaded = [];
  try {
    loaded = JSON.parse(loadedSnapshot);
  } catch {
    loaded = [];
  }
  const owned = new Set(ownedIds);
  const loadedById = new Map(loaded.map((t) => [t.id, JSON.stringify(t)]));
  const oursById = new Map(ours.map((t) => [t.id, t]));
  const out = [];
  const seen = new Set();
  for (const theirTask of theirs) {
    seen.add(theirTask.id);
    const mine = oursById.get(theirTask.id);
    if (!mine) {
      out.push(theirTask);
      continue;
    }
    const theirsUnchanged = loadedById.get(theirTask.id) === JSON.stringify(theirTask);
    out.push(owned.has(theirTask.id) || theirsUnchanged ? mine : theirTask);
  }
  for (const ourTask of ours) {
    if (!seen.has(ourTask.id)) out.push(ourTask);
  }
  return out;
}

/** Task ids are `issue-N` / `manual-N` / uuids; keep file names boring regardless. */
export function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
}

export default StateStore;
