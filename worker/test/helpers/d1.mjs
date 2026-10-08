// A real SQLite behind the D1 API, for tests. It uses node:sqlite (Node 22.13 or newer), so the real SQL of the real
// migrations runs in the tests. It covers the part of D1 that the Worker uses: prepare, bind, run, all, first, batch.
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../src/migrations.generated.js';

function norm(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class Statement {
  constructor(db, sql, calls) {
    this.db = db;
    this.sql = sql;
    this.args = [];
    this.calls = calls;
  }

  bind(...args) {
    this.args = args.map(norm);
    return this;
  }

  #exec(mode) {
    this.calls.push({ sql: this.sql, args: this.args });
    const stmt = this.db.prepare(this.sql);
    const returning = /\breturning\b/i.test(this.sql);
    if (mode === 'all' || returning || /^\s*(select|with|pragma)\b/i.test(this.sql)) {
      const rows = stmt.all(...this.args).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { changes: returning ? rows.length : 0, rows_read: rows.length } };
    }
    const info = stmt.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async run() {
    return this.#exec('run');
  }

  async all() {
    return this.#exec('all');
  }

  async first(column) {
    const { results } = this.#exec('all');
    const row = results[0] ?? null;
    if (row && column) return row[column];
    return row;
  }
}

/** @param {{ migrate?: boolean }} [opts] */
export function makeD1(opts = {}) {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const d1 = {
    calls,
    raw: db,
    prepare(sql) {
      return new Statement(db, sql, calls);
    },
    async batch(statements) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return out;
    },
    /** Every row of every table, for the "the key is nowhere" search. */
    dump() {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      const out = {};
      for (const t of tables) out[t] = db.prepare(`SELECT * FROM ${t}`).all().map((r) => ({ ...r }));
      return out;
    },
  };
  if (opts.migrate !== false) {
    for (const m of MIGRATIONS) for (const s of m.statements) db.exec(s);
  }
  return d1;
}
