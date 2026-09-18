/**
 * @file The append-only event record. One structured line per meaningful
 * thing that happens, under `state/events/<YYYY-MM-DD>.jsonl`, redacted
 * before it is written. Every derived view (snapshot, per-task timeline,
 * trace tree, analytics, replay) is computed from these lines and nothing
 * else — if a view ever disagrees with the events, the events win.
 *
 * Ids carried on every event when known: pulseId, taskId, runId, attempt,
 * stepId, agent, provider, toolCallId, parentId; plus durationMs, outcome,
 * failureClass, calls, tokens. `seq` is monotonic within the process and
 * continues from the last line of today's file so a day's file is totally
 * ordered even across pulses.
 *
 * Retention: `TITAN_EVENTS_RETENTION_DAYS` (default 14) daily files are
 * kept; older ones are compacted into `state/events/archive/<date>.json`
 * (counts by type, by outcome, by failure class — enough for analytics)
 * and deleted. The engine calls `compact()` once per pulse.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubForState } from '../lib/secretScrub.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('events');

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class EventLog {
  /**
   * @param {{ dir: string, pulseId: string, now?: () => Date, retentionDays?: number, echo?: boolean }} init
   */
  constructor(init) {
    this.dir = init.dir;
    this.pulseId = init.pulseId;
    this.now = init.now ?? (() => new Date());
    this.retentionDays = init.retentionDays ?? 14;
    this.echo = init.echo ?? false;
    /** @type {object[]} Everything appended in this process, for views and tests. */
    this.buffer = [];
    this.seq = 0;
    this.currentFile = null;
    /** @type {Array<(event: object) => void>} */
    this.listeners = [];
  }

  #fileFor(date) {
    return join(this.dir, `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  #ensureSeq(file) {
    if (this.currentFile === file) return;
    this.currentFile = file;
    this.needsNewline = false;
    let last = 0;
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      // A process killed mid-append leaves a torn last line with no newline;
      // the next append must start on a fresh line or both lines are lost.
      this.needsNewline = text.length > 0 && !text.endsWith('\n');
      const lines = text.trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (Number.isInteger(parsed?.seq)) {
            last = Math.max(last, parsed.seq);
            break;
          }
        } catch {
          // skip a torn last line
        }
      }
    }
    this.seq = Math.max(this.seq, last);
  }

  /**
   * @param {string} type Dotted lower-case name, e.g. `task.transition`.
   * @param {Record<string, unknown>} [fields]
   * @returns {object} The event as written.
   */
  append(type, fields = {}) {
    const ts = this.now();
    const file = this.#fileFor(ts);
    this.#ensureSeq(file);
    this.seq += 1;
    const event = scrubForState({ seq: this.seq, ts: ts.toISOString(), type, pulseId: this.pulseId, ...fields });
    this.buffer.push(event);
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(file, `${this.needsNewline ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8');
      this.needsNewline = false;
    } catch (err) {
      log.warn('event append failed', { type, error: String(err) });
    }
    if (this.echo) process.stdout.write(`${JSON.stringify({ event: type, ...trimForEcho(event) })}\n`);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // a subscriber must never break the engine
      }
    }
    return event;
  }

  /** @param {(event: object) => void} fn */
  subscribe(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }

  /** Read every event in the retained files, oldest first. */
  readAll() {
    return readEventsDir(this.dir);
  }

  /** Compact files older than the retention window into count summaries. */
  compact() {
    if (!existsSync(this.dir)) return { compacted: 0 };
    const cutoff = this.now().getTime() - this.retentionDays * 86_400_000;
    const archiveDir = join(this.dir, 'archive');
    let compacted = 0;
    for (const file of readdirSync(this.dir)) {
      const m = file.match(FILE_RE);
      if (!m) continue;
      if (Date.parse(`${m[1]}T00:00:00Z`) >= cutoff) continue;
      const events = readJsonlFile(join(this.dir, file));
      const summary = { date: m[1], events: events.length, byType: {}, byOutcome: {}, byFailureClass: {}, calls: 0, tokens: 0 };
      for (const e of events) {
        summary.byType[e.type] = (summary.byType[e.type] ?? 0) + 1;
        if (e.outcome) summary.byOutcome[e.outcome] = (summary.byOutcome[e.outcome] ?? 0) + 1;
        if (e.failureClass) summary.byFailureClass[e.failureClass] = (summary.byFailureClass[e.failureClass] ?? 0) + 1;
        summary.calls += Number(e.calls ?? 0);
        summary.tokens += Number(e.tokens ?? 0);
      }
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, `${m[1]}.json`), `${JSON.stringify(summary, null, 2)}\n`);
      unlinkSync(join(this.dir, file));
      compacted += 1;
    }
    return { compacted };
  }
}

function trimForEcho(event) {
  const { seq, ts, pulseId, ...rest } = event;
  return rest;
}

/** @param {string} path @returns {object[]} */
export function readJsonlFile(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn line from a killed process is dropped, never fatal
    }
  }
  return out;
}

/** @param {string} dir @returns {object[]} Oldest first across all retained daily files. */
export function readEventsDir(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  return files.flatMap((f) => readJsonlFile(join(dir, f)));
}

export default EventLog;
