/**
 * @file Applies missing D1 migrations from inside the Worker (Wave 12, X2).
 *
 * The deploy workflow runs `wrangler d1 migrations apply` before each deploy. That needs a Cloudflare token with
 * the D1 edit permission, and nobody has proved that the token has it. If the deploy step cannot apply a
 * migration, the new code would run with missing tables. This runner closes that gap. On the first request or
 * tick of each isolate it reads `d1_migrations`, which is the table that wrangler uses, and applies each file that
 * is missing. Migrations are additive, and a "duplicate column" error counts as already applied.
 */
import { MIGRATIONS, SCHEMA_VERSION } from '../migrations.generated.js';

let ready = null;

const ALREADY_DONE = /duplicate column name|already exists/i;

/** @param {{ DB: any }} env */
export async function ensureMigrations(env) {
  if (!env?.DB) return { applied: [], schemaVersion: SCHEMA_VERSION, skipped: true };
  if (ready) return ready;
  ready = (async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    ).run();
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all();
    const done = new Set((results ?? []).map((r) => r.name));
    const applied = [];
    for (const migration of MIGRATIONS) {
      if (done.has(migration.name)) continue;
      for (const statement of migration.statements) {
        try {
          await env.DB.prepare(statement).run();
        } catch (err) {
          if (!ALREADY_DONE.test(err instanceof Error ? err.message : String(err))) throw err;
        }
      }
      await env.DB.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)').bind(migration.name).run();
      applied.push(migration.name);
    }
    return { applied, schemaVersion: SCHEMA_VERSION, skipped: false };
  })().catch((err) => {
    ready = null; // try again on the next request
    throw err;
  });
  return ready;
}

/** For tests: forget that the migrations ran. */
export function resetMigrationState() {
  ready = null;
}

export { SCHEMA_VERSION };
