#!/usr/bin/env node
/**
 * @file CI gate for the public repository (overnight wave, rule 0.7).
 *
 * It scans three places for personal data and for key-shaped text:
 *   1. `state/`, the files that the pulse commits.
 *   2. The built Pages output (`dashboard/out`), when the folder exists.
 *   3. With `--issues`, the open and closed Issues and their comments (needs GITHUB_TOKEN and GITHUB_REPOSITORY).
 *
 * It prints the rule id and the place. It never prints the matched text.
 * Exit 0: clean. Exit 1: at least one match. Exit 2: a scan could not run.
 *
 * Usage: node scripts/check-public-pii.mjs [--issues] [--dir <path> ...]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { SECRET_PATTERNS } from '../src/lib/redact.js';
import { findPii } from '../src/lib/pii.js';

const ROOT = process.cwd();
const DEFAULT_DIRS = ['state', join('dashboard', 'out')];
const TEXT_EXT = /\.(?:json|jsonl|md|txt|html?|js|mjs|css|svg|ya?ml|xml|csv|map|gz)$/i;
// Hashes and ids in build output are long hex or base64 runs. The last two secret patterns are the generic ones.
const GENERIC_RUNS = 2;
const STRICT_SECRET_PATTERNS = SECRET_PATTERNS.slice(0, SECRET_PATTERNS.length - GENERIC_RUNS);
// Public bot addresses that are not personal data.
const EMAIL_ALLOW = /(?:noreply|no-reply)@|@users\.noreply\.github\.com$|@example\.(?:com|org)$|@github\.com$/i;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Array<{ rule: string, line: number }>}
 */
export function scanText(text) {
  const hits = findPii(text);
  for (let i = 0; i < STRICT_SECRET_PATTERNS.length; i += 1) {
    const pattern = new RegExp(STRICT_SECRET_PATTERNS[i].source, STRICT_SECRET_PATTERNS[i].flags);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      if (m[0].includes('@') && EMAIL_ALLOW.test(m[0])) continue;
      hits.push({ rule: `secret-pattern-${i}`, line: text.slice(0, m.index).split('\n').length });
    }
  }
  return hits;
}

/** @param {string} file */
function readText(file) {
  if (file.endsWith('.gz')) return gunzipSync(readFileSync(file)).toString('utf8');
  return readFileSync(file, 'utf8');
}

/** @param {string[]} dirs */
export function scanDirs(dirs) {
  /** @type {Array<{ file: string, rule: string, line: number }>} */
  const findings = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (!TEXT_EXT.test(file)) continue;
      let text;
      try {
        text = readText(file);
      } catch {
        continue;
      }
      scanned += 1;
      for (const h of scanText(text)) findings.push({ file: relative(ROOT, file), ...h });
    }
  }
  return { findings, scanned };
}

async function scanIssues() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are needed for --issues');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'titan-runner-pii-check' };
  /** @type {Array<{ file: string, rule: string, line: number }>} */
  const findings = [];
  let scanned = 0;
  for (const path of ['issues?state=all', 'issues/comments']) {
    for (let page = 1; page <= 20; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`https://api.github.com/repos/${repo}/${path}${sep}per_page=100&page=${page}`, { headers });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
      const rows = await res.json();
      for (const row of rows) {
        scanned += 1;
        const text = `${row.title ?? ''}\n${row.body ?? ''}`;
        for (const h of scanText(text)) findings.push({ file: `${path.startsWith('issues/') ? 'comment' : 'issue'} ${row.html_url}`, ...h });
      }
      if (rows.length < 100) break;
    }
  }
  return { findings, scanned };
}

async function main() {
  const args = process.argv.slice(2);
  const dirs = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--dir' && args[i + 1]) dirs.push(args[(i += 1)]);
  const targets = (dirs.length > 0 ? dirs : DEFAULT_DIRS).map((d) => join(ROOT, d));
  const all = scanDirs(targets);
  if (args.includes('--issues')) {
    const issues = await scanIssues();
    all.findings.push(...issues.findings);
    all.scanned += issues.scanned;
  }
  for (const f of all.findings) console.error(`${f.rule} in ${f.file} at line ${f.line}`);
  if (all.findings.length > 0) {
    console.error(`\ncheck-public-pii: ${all.findings.length} finding(s). This repository is public. Remove the data. The text is not printed here.`);
    process.exit(1);
  }
  console.log(`check-public-pii: clean (${all.scanned} item(s) scanned).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`check-public-pii: could not run: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
