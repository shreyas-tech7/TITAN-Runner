"use client";

import type { Priority, RoutingHint } from "./taskYaml";
import type { TaskRecord } from "./types";

/**
 * Optimistic UI (task instructions, section 1): on a successful issue
 * creation the task appears immediately in the queue as "queued, waiting
 * for next pulse," before `state/tasks.json` has caught up (which can take
 * up to ~15 minutes — the next cron tick). Stored in `localStorage` so it
 * survives a reload while waiting; reconciled away the moment the real
 * state file shows the same issue number, so nothing is ever misrepresented
 * as server-confirmed for longer than it takes the next pulse to run.
 */
export interface OptimisticTask {
  localId: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  priority: Priority;
  routingHint: RoutingHint;
  createdAt: string;
}

const STORAGE_KEY = "titan-runner:optimistic-tasks:v1";
/** A task still shown as optimistic this long after filing almost certainly
 *  means the pulse already ran and either claimed it under a shape this
 *  reconciliation didn't match, or something failed — stop claiming
 *  "waiting for next pulse" past this point rather than mislead forever. */
const MAX_AGE_MS = 60 * 60_000;

function readAll(): OptimisticTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(tasks: OptimisticTask[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Best-effort — worst case the optimistic row disappears on next reload.
  }
}

export function listOptimisticTasks(): OptimisticTask[] {
  const all = readAll();
  const fresh = all.filter((t) => Date.now() - Date.parse(t.createdAt) < MAX_AGE_MS);
  if (fresh.length !== all.length) writeAll(fresh); // drop stale entries in passing
  return fresh;
}

export function addOptimisticTask(task: OptimisticTask): void {
  writeAll([...readAll(), task]);
}

export function removeOptimisticTask(issueNumber: number): void {
  writeAll(readAll().filter((t) => t.issueNumber !== issueNumber));
}

/** Drop any optimistic entry the real state file has now confirmed. Call this on every fresh poll of state/tasks.json. */
export function reconcileOptimisticTasks(realTasks: TaskRecord[]): void {
  const knownIssueNumbers = new Set(realTasks.map((t) => t.issueNumber).filter((n): n is number => n !== null));
  const remaining = readAll().filter((t) => !knownIssueNumbers.has(t.issueNumber));
  if (remaining.length !== readAll().length) writeAll(remaining);
}
