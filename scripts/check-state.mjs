#!/usr/bin/env node
/**
 * @file Validates every file under `state/` (RT7).
 *
 *   1. Each file must have a strict schema in `src/state/strict.js`. A file with no schema fails.
 *   2. Each JSON file, each line of a JSONL file, and each line of a compressed archive must match its schema.
 *      The schemas forbid extra fields.
 *   3. The text of each file, after it is decompressed, must hold no secret-shaped string.
 *   4. With `--gitleaks`, gitleaks scans the folder too.
 *
 * It prints the file and the field. It never prints a value: messages pass through the redactor first.
 *
 * Usage: node scripts/check-state.mjs [--dir state] [--gitleaks] [--max-errors 30]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { validate } from '../src/lib/validate.js';
import { SECRET_PATTERNS, redactString } from '../src/lib/redact.js';
import { schemaFor } from '../src/state/strict.js';

const SKIP_DIRS = new Set(['workspaces', 'quarantine']); // these two are in .gitignore
const MAX_TEXT_BYTES = 400_000;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (dir === base && SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(join(dir, entry.name), base));
    } else if (entry.isFile()) out.push(join(dir, entry.name));
  }
  return out.sort();
}

const clean = (message) => redactString(String(message)).slice(0, 240);

/**
 * Check one file. Returns a list of problems.
 * @param {string} rel Path relative to `state/`, with `/`.
 * @param {Buffer} bytes
 * @returns {string[]}
 */
export function checkStateFile(rel, bytes) {
  const found = schemaFor(rel);
  if (!found) return [`${rel}: no schema. Add one to src/state/strict.js in the same change that writes this file.`];
  const problems = [];
  let text;
  try {
    text = found.kind === 'gz-jsonl' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  } catch {
    return [`${rel}: the file is not valid ${found.kind === 'gz-jsonl' ? 'gzip' : 'text'}.`];
  }
  if (text.length > MAX_TEXT_BYTES * 8) problems.push(`${rel}: the file is larger than ${MAX_TEXT_BYTES * 8} characters.`);

  for (const pattern of SECRET_PATTERNS.slice(0, -2)) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) problems.push(`${rel}: a secret-shaped string (pattern ${pattern}).`);
  }

  if (found.kind === 'text') {
    if (bytes.length > MAX_TEXT_BYTES) problems.push(`${rel}: the text file is larger than ${MAX_TEXT_BYTES} bytes.`);
    return problems;
  }
  if (found.kind === 'json') {
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      return [...problems, `${rel}: invalid JSON (${clean(err.message)}).`];
    }
    for (const e of validate(value, found.schema)) problems.push(`${rel}: ${clean(e)}`);
    return problems;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      problems.push(`${rel}:${i + 1}: invalid JSON (${clean(err.message)}).`);
      return;
    }
    for (const e of validate(value, found.schema).slice(0, 5)) problems.push(`${rel}:${i + 1}: ${clean(e)}`);
  });
  return problems;
}

/** @returns {{ files: number, problems: string[] }} */
export function checkStateDir(dir) {
  const root = resolve(dir);
  if (!existsSync(root)) return { files: 0, problems: [] };
  const files = walk(root);
  const problems = [];
  for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/');
    problems.push(...checkStateFile(rel, readFileSync(file)));
  }
  return { files: files.length, problems };
}

function runGitleaks(dir) {
  const bin = process.env.GITLEAKS_BIN || 'gitleaks';
  const probe = spawnSync(bin, ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return { ok: false, message: `gitleaks is not installed (looked for "${bin}")` };
  const res = spawnSync(bin, ['dir', dir, '--config', '.gitleaks.toml', '--redact=100', '--no-banner', '--max-archive-depth', '2'], { encoding: 'utf8' });
  return { ok: res.status === 0, message: res.status === 0 ? 'gitleaks: no findings' : `gitleaks found something in ${dir} (exit ${res.status}). Run it by hand for the rule and the line.` };
}

const invokedDirectly = process.argv[1] && /check-state\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--dir');
  const dir = dirIndex >= 0 ? args[dirIndex + 1] : 'state';
  const maxIndex = args.indexOf('--max-errors');
  const maxErrors = maxIndex >= 0 ? Number(args[maxIndex + 1]) : 30;
  const { files, problems } = checkStateDir(dir);
  let failed = problems.length > 0;
  for (const p of problems.slice(0, maxErrors)) console.error(`  ${p}`);
  if (problems.length > maxErrors) console.error(`  ... and ${problems.length - maxErrors} more`);
  if (args.includes('--gitleaks')) {
    const g = runGitleaks(dir);
    console[g.ok ? 'log' : 'error'](g.message);
    if (!g.ok) failed = true;
  }
  if (failed) {
    console.error(`check-state: ${problems.length} problem(s) in ${files} file(s) under ${dir}/.`);
    process.exit(1);
  }
  console.log(`check-state: ${files} file(s) under ${dir}/ match their strict schemas.`);
}
