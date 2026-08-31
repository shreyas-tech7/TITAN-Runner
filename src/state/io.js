/**
 * @file The repo IS the database. Every pulse reads these files at the
 * start of its run and (if anything changed) commits new versions at the
 * end. No SQLite, no external store — a stateless GitHub Actions runner
 * cannot rely on anything surviving between pulses except what is actually
 * committed to git.
 *
 * Writes go through a write-to-temp-then-rename so a pulse that crashes
 * mid-write never leaves a half-written JSON file for the next pulse (or a
 * human) to trip over.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../lib/logger.js';

const log = createLogger('state:io');

export const STATE_DIR = join(process.cwd(), 'state');
export const TASKS_PATH = join(STATE_DIR, 'tasks.json');
export const AGENTS_PATH = join(STATE_DIR, 'agents.json');
export const HEARTBEAT_PATH = join(STATE_DIR, 'heartbeat.json');
export const RUNS_DIR = join(STATE_DIR, 'runs');
export const DIGESTS_DIR = join(STATE_DIR, 'digests');
export const REVIEWS_DIR = join(STATE_DIR, 'reviews');

/**
 * @param {string} path
 * @param {unknown} fallback
 * @returns {any}
 */
export function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log.warn('state read failed — using fallback', { path, error: String(err) });
    return fallback;
  }
}

/**
 * @param {string} path
 * @param {unknown} data
 */
export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export function defaultTasksState() {
  return { version: 1, updatedAt: new Date(0).toISOString(), tasks: [] };
}

export function defaultHeartbeatState() {
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

/** Ensures every state file/dir this repo depends on exists, seeding defaults
 *  the first time a pulse runs against a freshly-checked-out repo. */
export function ensureStateFiles() {
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(DIGESTS_DIR, { recursive: true });
  mkdirSync(REVIEWS_DIR, { recursive: true });
  if (!existsSync(TASKS_PATH)) writeJsonAtomic(TASKS_PATH, defaultTasksState());
  if (!existsSync(HEARTBEAT_PATH)) writeJsonAtomic(HEARTBEAT_PATH, defaultHeartbeatState());
  if (!existsSync(AGENTS_PATH)) writeJsonAtomic(AGENTS_PATH, {});
}

export function loadTasksState() {
  return readJson(TASKS_PATH, defaultTasksState());
}

export function saveTasksState(state) {
  writeJsonAtomic(TASKS_PATH, { ...state, updatedAt: new Date().toISOString() });
}

export function loadHeartbeat() {
  return readJson(HEARTBEAT_PATH, defaultHeartbeatState());
}

export function saveHeartbeat(state) {
  writeJsonAtomic(HEARTBEAT_PATH, state);
}
