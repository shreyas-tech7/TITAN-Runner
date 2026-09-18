/**
 * @file The built-in tools. Four deliberately small capabilities a step
 * can ask for, each jailed:
 *
 *   repo_read_file   read one file from the checkout (read jail: no `.git/`,
 *                    no `node_modules/`, no credential-shaped names, no
 *                    traversal or symlink escape; size-capped)
 *   repo_list_files  list a directory of the checkout, depth-limited
 *   repo_search      plain-text or regex search over the checkout, bounded
 *   workspace_write  write a file into the task's own workspace under the
 *                    state directory (`state/workspaces/<taskId>/`), never
 *                    into the checkout — the synthesizer and the
 *                    self-improve path decide what reaches the repo
 *   http_fetch       GET one https URL on the operator's egress allowlist,
 *                    after the SSRF check (`tools/ssrf.js`); no redirects,
 *                    size- and time-capped
 *
 * Nothing here shells out, deletes, or touches git.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { checkRepoRelativePath } from '../lib/pathJail.js';
import { checkEgress, parseAllowlist } from './ssrf.js';
import { guardedFetch } from '../lib/net.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_HITS = 60;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_FETCH_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'coverage']);

function jailedRead(root, rel) {
  const jail = checkRepoRelativePath(root, rel, { mode: 'read' });
  if (!jail.ok) throw new Error(`refused: ${jail.reason}`);
  return jail;
}

/**
 * @param {{ repoRoot: string, workspaceRoot: string, allowlist?: string[]|string, fetchImpl?: Function, lookup?: Function }} opts
 * @returns {import('./registry.js').ToolDefinition[]}
 */
export function builtinTools(opts) {
  const repoRoot = opts.repoRoot;
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : parseAllowlist(opts.allowlist ?? process.env.TITAN_EGRESS_ALLOWLIST ?? '');
  const fetchImpl = opts.fetchImpl ?? guardedFetch;

  return [
    {
      id: 'repo_read_file',
      description: 'Read one text file from the repository checkout.',
      effect: 'read', riskLevel: 'low', idempotent: true, timeoutMs: 3000,
      schema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 240 }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES } } },
      async run(args) {
        const jail = jailedRead(repoRoot, args.path);
        if (!existsSync(jail.absolute)) throw new Error(`no such file: ${jail.relative}`);
        const st = statSync(jail.absolute);
        if (!st.isFile()) throw new Error(`not a file: ${jail.relative}`);
        const cap = Math.min(args.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
        const buf = readFileSync(jail.absolute);
        const text = buf.subarray(0, cap).toString('utf8');
        return buf.length > cap ? `${text}\n…[truncated: ${buf.length - cap} more bytes]` : text;
      },
    },
    {
      id: 'repo_list_files',
      description: 'List files under a directory of the repository checkout (depth-limited).',
      effect: 'read', riskLevel: 'low', idempotent: true, timeoutMs: 3000,
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', maxLength: 240 }, depth: { type: 'integer', minimum: 1, maximum: 3 } } },
      async run(args) {
        const rel = args.path && args.path !== '.' ? args.path : '';
        const base = rel ? jailedRead(repoRoot, rel).absolute : repoRoot;
        if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`not a directory: ${rel || '.'}`);
        const out = [];
        const walk = (dir, depth) => {
          if (out.length >= MAX_LIST_ENTRIES) return;
          for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= MAX_LIST_ENTRIES) return;
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(dir, entry.name);
            const shown = relative(repoRoot, full).split(sep).join('/');
            if (entry.isDirectory()) {
              out.push(`${shown}/`);
              if (depth > 1) walk(full, depth - 1);
            } else if (entry.isFile()) {
              out.push(shown);
            }
          }
        };
        walk(base, args.depth ?? 2);
        return out.length === 0 ? '(empty)' : out.join('\n') + (out.length >= MAX_LIST_ENTRIES ? '\n…[list truncated]' : '');
      },
    },
    {
      id: 'repo_search',
      description: 'Search the repository checkout for a plain string or a regular expression; returns matching lines with paths.',
      effect: 'read', riskLevel: 'low', idempotent: true, timeoutMs: 5000,
      schema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, regex: { type: 'boolean' }, path: { type: 'string', maxLength: 240 }, glob: { type: 'string', maxLength: 60 } } },
      async run(args) {
        let matcher;
        if (args.regex) {
          try {
            matcher = new RegExp(args.query, 'i');
          } catch (err) {
            throw new Error(`invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          const needle = args.query.toLowerCase();
          matcher = { test: (line) => line.toLowerCase().includes(needle) };
        }
        const ext = args.glob && /^\*\.[a-z0-9]+$/i.test(args.glob) ? args.glob.slice(1).toLowerCase() : null;
        const base = args.path && args.path !== '.' ? jailedRead(repoRoot, args.path).absolute : repoRoot;
        const hits = [];
        let files = 0;
        const walk = (dir) => {
          if (files >= MAX_SEARCH_FILES || hits.length >= MAX_SEARCH_HITS) return;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (files >= MAX_SEARCH_FILES || hits.length >= MAX_SEARCH_HITS) return;
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
              continue;
            }
            if (!entry.isFile()) continue;
            if (ext && !entry.name.toLowerCase().endsWith(ext)) continue;
            if (lstatSync(full).isSymbolicLink()) continue;
            files += 1;
            const st = statSync(full);
            if (st.size > MAX_SEARCH_FILE_BYTES) continue;
            const rel = relative(repoRoot, full).split(sep).join('/');
            if (!checkRepoRelativePath(repoRoot, rel, { mode: 'read' }).ok) continue;
            const lines = readFileSync(full, 'utf8').split('\n');
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i += 1) {
              if (matcher.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        };
        if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error('search path is not a directory');
        walk(base);
        return hits.length === 0 ? '(no matches)' : hits.join('\n') + (hits.length >= MAX_SEARCH_HITS ? '\n…[more matches omitted]' : '');
      },
    },
    {
      id: 'workspace_write',
      description: 'Write a text file into this task\'s private workspace (not the repository); use for drafts and scratch output.',
      effect: 'local_write', riskLevel: 'medium', idempotent: true, timeoutMs: 3000,
      schema: { type: 'object', required: ['path', 'content'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 240 }, content: { type: 'string', maxLength: MAX_WRITE_BYTES } } },
      async run(args, ctx) {
        const taskId = String(ctx.taskId ?? 'task').replace(/[^A-Za-z0-9._-]/g, '_');
        const workspace = join(opts.workspaceRoot, taskId);
        const jail = checkRepoRelativePath(workspace, args.path);
        if (!jail.ok) throw new Error(`refused: ${jail.reason}`);
        mkdirSync(join(jail.absolute, '..'), { recursive: true });
        writeFileSync(jail.absolute, args.content, 'utf8');
        return `wrote ${Buffer.byteLength(args.content)} bytes to workspace/${jail.relative}`;
      },
    },
    {
      id: 'http_fetch',
      description: 'GET one https URL from the operator\'s egress allowlist and return the response text (no redirects, 64 KB cap).',
      effect: 'external', riskLevel: 'medium', idempotent: true, timeoutMs: FETCH_TIMEOUT_MS + 2000,
      schema: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 8, maxLength: 2000 } } },
      async run(args, ctx) {
        const egress = await checkEgress(args.url, { allowlist, lookup: opts.lookup });
        if (!egress.ok) throw new Error(`refused: ${egress.reason}`);
        const res = await fetchImpl(egress.url.toString(), { method: 'GET', redirect: 'manual', timeoutMs: FETCH_TIMEOUT_MS, signal: ctx.signal, headers: { accept: 'text/plain, text/markdown, application/json, text/html;q=0.5', 'user-agent': 'TITAN-Runner tool' } });
        if (res.status >= 300 && res.status < 400) throw new Error(`refused: the server answered with a redirect (${res.status}), which is not followed`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text.length > MAX_FETCH_BYTES ? `${text.slice(0, MAX_FETCH_BYTES)}\n…[truncated]` : text;
      },
    },
  ];
}

export default builtinTools;
