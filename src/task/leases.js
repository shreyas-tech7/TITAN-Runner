/**
 * @file Lease-based ownership of work. A pulse may run a task only while it
 * holds the task's lease; a lease has an owner and an expiry, so a pulse
 * that dies leaves a lease that the next pulse can see has expired and
 * reclaim (`task/reconcile.js`).
 *
 * Two copies, on purpose:
 *
 *   - `state/leases/<taskId>.json` is the authoritative lock. It is
 *     acquired by an O_EXCL create (`wx`), which is atomic on a local
 *     filesystem, so two pulses racing on the same checkout cannot both
 *     win — the case the benchmark's overlapping-pulses scenario drives,
 *     and the case a manual `workflow_dispatch` on a laptop checkout hits.
 *     Across machines it becomes visible when the checkpoint commit lands.
 *   - `task.lease` on the task record mirrors it for the dashboard and for
 *     reconciliation, which only has `tasks.json` to look at after a
 *     `git pull` that may have brought a newer lease file too.
 *
 * Expired lease files are replaced with an atomic rename, never appended to
 * or edited in place.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_LEASE_TTL_MS = 15 * 60_000; // longer than the workflow's 10-minute hard kill

export class LeaseManager {
  /**
   * @param {{ dir: string, owner: string, ttlMs?: number, now?: () => Date }} init
   */
  constructor(init) {
    this.dir = init.dir;
    this.owner = init.owner;
    this.ttlMs = init.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = init.now ?? (() => new Date());
    /** @type {Set<string>} paths written/removed, for the checkpointer */
    this.written = new Set();
  }

  pathFor(taskId) {
    return join(this.dir, `${String(taskId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  }

  /** @returns {{ owner: string, acquiredAt: string, expiresAt: string } | null} */
  read(taskId) {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed.owner === 'string' && typeof parsed.expiresAt === 'string' ? parsed : null;
    } catch {
      return null; // a torn file is treated as no lease; a fresh one replaces it
    }
  }

  isExpired(lease) {
    if (!lease) return true;
    const at = Date.parse(lease.expiresAt);
    return !Number.isFinite(at) || at <= this.now().getTime();
  }

  /**
   * Try to take the lease. Wins when no lease exists, when the existing one
   * is expired, or when this same owner already holds it (re-entrant).
   * @param {string} taskId
   * @returns {{ ok: true, lease: object } | { ok: false, heldBy: string, expiresAt: string }}
   */
  acquire(taskId) {
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(taskId);
    const lease = { owner: this.owner, acquiredAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString() };
    const text = `${JSON.stringify(lease, null, 2)}\n`;
    try {
      writeFileSync(path, text, { flag: 'wx' });
      this.written.add(path);
      return { ok: true, lease };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const existing = this.read(taskId);
    if (existing && !this.isExpired(existing) && existing.owner !== this.owner) {
      return { ok: false, heldBy: existing.owner, expiresAt: existing.expiresAt };
    }
    // Expired, torn, or ours: replace atomically.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    this.written.add(path);
    return { ok: true, lease };
  }

  /** Extend a lease we hold. No-op if someone else holds it now. */
  renew(taskId) {
    const existing = this.read(taskId);
    if (existing && existing.owner !== this.owner && !this.isExpired(existing)) return null;
    const lease = { owner: this.owner, acquiredAt: existing?.owner === this.owner ? existing.acquiredAt : this.now().toISOString(), expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString() };
    const path = this.pathFor(taskId);
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
    renameSync(tmp, path);
    this.written.add(path);
    return lease;
  }

  release(taskId) {
    const path = this.pathFor(taskId);
    const existing = this.read(taskId);
    if (existing && existing.owner !== this.owner && !this.isExpired(existing)) return false;
    if (existsSync(path)) {
      unlinkSync(path);
      this.written.add(path);
    }
    return true;
  }
}

export default LeaseManager;
