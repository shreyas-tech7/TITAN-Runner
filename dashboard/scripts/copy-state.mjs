#!/usr/bin/env node
/**
 * Copies the repo's committed `state/*.json` into `dashboard/public/state/`
 * so the static export serves a same-origin snapshot as of the last
 * dashboard build — the fallback `lib/usePolledJson.ts` uses when
 * raw.githubusercontent.com is unreachable or rate-limited. Run as part of
 * `npm run build` (see package.json), never committed itself
 * (`dashboard/public/state/` is gitignored — it's a build artifact, not a
 * second copy of the source of truth).
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', '..', 'state');
const DEST = join(__dirname, '..', 'public', 'state');

mkdirSync(DEST, { recursive: true });

if (!existsSync(SRC)) {
  console.warn(`No ${SRC} found — skipping state copy (fine for a first-time checkout before any pulse has run).`);
  process.exit(0);
}

let copied = 0;
for (const entry of readdirSync(SRC, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.json')) {
    copyFileSync(join(SRC, entry.name), join(DEST, entry.name));
    copied += 1;
  }
}
console.log(`Copied ${copied} state file(s) into dashboard/public/state/.`);
