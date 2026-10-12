#!/usr/bin/env node
/**
 * @file Scans the text of open Issues, open pull requests, and their comments for secrets (RT1).
 *
 * Anyone can write on a public repository. A person can paste a key into an Issue by mistake.
 * This script reads that text through the GitHub API and runs gitleaks over it.
 *
 * It prints the rule name and a link for each match. It never prints the matched value.
 * Exit code 0: no match. Exit code 1: at least one match. Exit code 2: the scan could not run.
 *
 * Usage:
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/scan-issues.mjs [--all] [--config .gitleaks.toml]
 *
 * `--all` includes closed Issues and pull requests. The default is open items only.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 20;

/**
 * Read every page of a list endpoint.
 * @param {(url: string) => Promise<any[]>} getPage
 * @param {string} path Path with a query string, without per_page and page.
 */
async function listAll(getPage, path) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const rows = await getPage(`${API}${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(rows)) throw new Error(`unexpected response for ${path}`);
    out.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

/**
 * Collect the text to scan. Pure apart from the injected `getPage`.
 * @param {{ repository: string, includeClosed?: boolean, getPage: (url: string) => Promise<any[]> }} opts
 * @returns {Promise<Array<{ name: string, link: string, text: string }>>}
 */
export async function collectTexts({ repository, includeClosed = false, getPage }) {
  const state = includeClosed ? 'all' : 'open';
  const base = `https://github.com/${repository}`;
  const texts = [];
  const issues = await listAll(getPage, `/repos/${repository}/issues?state=${state}`);
  const wanted = new Set();
  for (const issue of issues) {
    wanted.add(issue.number);
    const kind = issue.pull_request ? 'pull' : 'issues';
    texts.push({ name: `issue-${issue.number}`, link: `${base}/${kind}/${issue.number}`, text: `${issue.title ?? ''}\n${issue.body ?? ''}` });
  }
  const comments = await listAll(getPage, `/repos/${repository}/issues/comments`);
  for (const c of comments) {
    const number = Number(String(c.issue_url ?? '').split('/').pop());
    if (!wanted.has(number)) continue;
    texts.push({ name: `comment-${c.id}`, link: c.html_url ?? `${base}/issues/${number}`, text: c.body ?? '' });
  }
  const reviewComments = await listAll(getPage, `/repos/${repository}/pulls/comments`);
  for (const c of reviewComments) {
    const number = Number(String(c.pull_request_url ?? '').split('/').pop());
    if (!wanted.has(number)) continue;
    texts.push({ name: `review-comment-${c.id}`, link: c.html_url ?? `${base}/pull/${number}`, text: c.body ?? '' });
  }
  return texts;
}

/**
 * Run gitleaks over the texts.
 * @param {Array<{ name: string, link: string, text: string }>} texts
 * @param {{ gitleaks?: string, config?: string, run?: (cmd: string, args: string[]) => { status: number|null, stderr?: string } }} [opts]
 * @returns {{ ok: boolean, matches: Array<{ rule: string, link: string }> }}
 */
export function scanTexts(texts, opts = {}) {
  const gitleaks = opts.gitleaks ?? 'gitleaks';
  const run = opts.run ?? ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }));
  const dir = mkdtempSync(join(tmpdir(), 'titan-issue-scan-'));
  const textDir = join(dir, 'texts');
  const report = join(dir, 'report.json');
  try {
    mkdirSync(textDir);
    const byFile = new Map();
    for (const t of texts) {
      const file = `${t.name}.txt`;
      writeFileSync(join(textDir, file), t.text, { mode: 0o600 });
      byFile.set(file, t.link);
    }
    const args = ['dir', textDir, '--no-banner', '--redact=100', '--report-format', 'json', '--report-path', report, '--exit-code', '0'];
    if (opts.config) args.push('--config', opts.config);
    const res = run(gitleaks, args);
    if (res.status !== 0) throw new Error(`gitleaks exited with status ${res.status}`);
    let found = [];
    try {
      found = JSON.parse(readFileSync(report, 'utf8'));
    } catch {
      found = [];
    }
    const matches = found.map((f) => {
      const file = String(f.File ?? '').split('/').pop();
      return { rule: String(f.RuleID ?? 'unknown'), link: byFile.get(file) ?? 'unknown location' };
    });
    return { ok: matches.length === 0, matches };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    console.error('scan-issues: set GITHUB_TOKEN and GITHUB_REPOSITORY.');
    process.exit(2);
  }
  const configIndex = args.indexOf('--config');
  const config = configIndex >= 0 ? args[configIndex + 1] : '.gitleaks.toml';
  const getPage = async (url) => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${new URL(url).pathname}`);
    return res.json();
  };
  let texts;
  try {
    texts = await collectTexts({ repository, includeClosed: args.includes('--all'), getPage });
  } catch (err) {
    console.error(`scan-issues: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  let result;
  try {
    result = scanTexts(texts, { config, gitleaks: process.env.GITLEAKS_BIN || 'gitleaks' });
  } catch (err) {
    console.error(`scan-issues: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  if (!result.ok) {
    console.error(`scan-issues: ${result.matches.length} possible secret(s) in public text. Rotate the credential, then edit or delete the text.`);
    for (const m of result.matches) console.error(`  rule ${m.rule} at ${m.link}`);
    process.exit(1);
  }
  console.log(`scan-issues: clean (${texts.length} text(s) scanned).`);
}

const invokedDirectly = process.argv[1] && /scan-issues\.mjs$/.test(process.argv[1]);
if (invokedDirectly) await main();
