import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaseManager } from '../src/task/leases.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'titan-leases-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a second owner cannot take a live lease; it can once the lease expired; the same owner is re-entrant', () => {
  const { dir, cleanup } = scratch();
  try {
    let t = 1_000_000;
    const now = () => new Date(t);
    const a = new LeaseManager({ dir, owner: 'pulse-a', ttlMs: 1000, now });
    const b = new LeaseManager({ dir, owner: 'pulse-b', ttlMs: 1000, now });
    assert.equal(a.acquire('task-1').ok, true);
    const denied = b.acquire('task-1');
    assert.equal(denied.ok, false);
    assert.equal(denied.heldBy, 'pulse-a');
    assert.equal(a.acquire('task-1').ok, true, 're-entrant');
    t += 1001;
    const taken = b.acquire('task-1');
    assert.equal(taken.ok, true, 'expired lease is reclaimable');
    assert.equal(b.read('task-1').owner, 'pulse-b');
    assert.equal(a.release('task-1'), false, 'a cannot release a lease b now holds');
    assert.equal(b.release('task-1'), true);
    assert.equal(existsSync(a.pathFor('task-1')), false);
  } finally {
    cleanup();
  }
});

test('renew extends only a lease we hold; a torn lease file counts as no lease', () => {
  const { dir, cleanup } = scratch();
  try {
    let t = 5_000_000;
    const now = () => new Date(t);
    const a = new LeaseManager({ dir, owner: 'a', ttlMs: 1000, now });
    const b = new LeaseManager({ dir, owner: 'b', ttlMs: 1000, now });
    a.acquire('x');
    t += 500;
    const renewed = a.renew('x');
    assert.equal(Date.parse(renewed.expiresAt), t + 1000);
    assert.equal(b.renew('x'), null, 'b cannot renew a lease a holds');
    writeFileSync(a.pathFor('y'), '{"owner": "a", "expi');
    assert.equal(a.read('y'), null);
    assert.equal(b.acquire('y').ok, true);
  } finally {
    cleanup();
  }
});

test('two real processes racing for the same lease: exactly one wins (O_EXCL is the arbiter)', async () => {
  const { dir, cleanup } = scratch();
  try {
    const script = `
      import { LeaseManager } from ${JSON.stringify(new URL('../src/task/leases.js', import.meta.url).href)};
      const m = new LeaseManager({ dir: process.argv[2], owner: process.argv[3], ttlMs: 60000 });
      const r = m.acquire('shared');
      process.stdout.write(JSON.stringify({ owner: process.argv[3], ok: r.ok }));
    `;
    const runner = join(dir, 'race.mjs');
    writeFileSync(runner, script);
    const run = (owner) => new Promise((resolve) => {
      const child = spawn(process.execPath, [runner, dir, owner], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('exit', () => resolve(JSON.parse(out)));
    });
    const results = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(run));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const m = new LeaseManager({ dir, owner: 'observer' });
    assert.equal(m.read('shared').owner, winners[0].owner);
  } finally {
    cleanup();
  }
});
