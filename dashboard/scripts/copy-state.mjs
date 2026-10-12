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
// The derived views (state/views/*.json) the v2 engine writes every pulse.
const VIEWS = join(SRC, 'views');
if (existsSync(VIEWS)) {
  mkdirSync(join(DEST, 'views'), { recursive: true });
  for (const entry of readdirSync(VIEWS, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      copyFileSync(join(VIEWS, entry.name), join(DEST, 'views', entry.name));
      copied += 1;
    }
  }
}
// The ops mirrors (state/ops/*.json), for the ops panels.
const OPS = join(SRC, 'ops');
if (existsSync(OPS)) {
  mkdirSync(join(DEST, 'ops'), { recursive: true });
  for (const entry of readdirSync(OPS, { withFileTypes: true })) {
    // The host history is a work file of the probe. The panels read only the mirror.
    if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'hosts-history.json') {
      copyFileSync(join(OPS, entry.name), join(DEST, 'ops', entry.name));
      copied += 1;
    }
  }
}
// The lessons of the post-mortems (one JSON object on each line).
if (existsSync(join(SRC, 'lessons.jsonl'))) {
  copyFileSync(join(SRC, 'lessons.jsonl'), join(DEST, 'lessons.jsonl'));
  copied += 1;
}
console.log(`Copied ${copied} state file(s) into dashboard/public/state/.`);
