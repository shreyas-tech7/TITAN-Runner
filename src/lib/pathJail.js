/**
 * @file A working-directory jail for every file Runner writes on behalf of a
 * model. `orchestrator/outputParser.js`'s `normalizePath` already drops `..`
 * segments and leading slashes, but normalisation is not containment: a path
 * can still name `.git/hooks/post-checkout` (executed by the very next
 * `git checkout` in the same job, with every provider key in the
 * environment), `.github/ISSUE_TEMPLATE/x.yml` (controls which labels a
 * stranger's issue gets), `package.json` (controls what `npm ci` and
 * `npm test` run in CI), or a path whose ancestor is a symlink out of the
 * checkout. This module says no to all of those before a single byte is
 * written, and it is the one place that rule lives.
 */
import { lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Path segments that are never writable, at any depth. */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.github', 'node_modules']);

/** Repo-root files a model may never write (case-insensitive). */
const FORBIDDEN_ROOT_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.nvmrc',
  '.gitmodules', '.gitattributes', '.gitignore',
]);

const FORBIDDEN_NAME_PATTERN = /^\.env(\.|$)|\.pem$|\.key$|\.pfx$|id_rsa|credentials\.json$|token\.json$/i;

const MAX_PATH_LENGTH = 240;

/** Any byte below 0x20 or the DEL byte, checked by code point so the source
 *  file itself never has to contain a control character. */
function hasControlCharacters(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * @param {string} root Absolute checkout root.
 * @param {object} [opts] `{ mode: 'read' }` for the read jail (see below).
 * @param {string} rel A repo-relative path as the model proposed it (already
 *   through `normalizePath`, but this function does not rely on that).
 * @returns {{ ok: true, absolute: string, relative: string } | { ok: false, reason: string }}
 */
export function checkRepoRelativePath(root, rel, opts = {}) {
  // `mode: 'read'` is the tool registry's read jail: the same traversal,
  // symlink, and credential-name rules, but `.github/` and the root
  // manifests may be *read* (a research step legitimately looks at them);
  // `.git/` and `node_modules/` stay off limits in both modes.
  const mode = opts.mode === 'read' ? 'read' : 'write';
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'empty path' };
  if (rel.length > MAX_PATH_LENGTH) return { ok: false, reason: `path longer than ${MAX_PATH_LENGTH} characters` };
  if (hasControlCharacters(rel)) return { ok: false, reason: 'path contains control characters' };
  const normalized = rel.replace(/\\/g, '/');
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    return { ok: false, reason: 'absolute paths are not allowed' };
  }
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { ok: false, reason: 'empty path' };
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, reason: 'path traversal segment' };
    const lower = seg.toLowerCase();
    if (FORBIDDEN_SEGMENTS.has(lower) && !(mode === 'read' && lower === '.github')) return { ok: false, reason: `"${seg}" is a protected directory` };
    if (FORBIDDEN_NAME_PATTERN.test(seg)) return { ok: false, reason: `"${seg}" looks like a credential or environment file` };
  }
  if (mode === 'write' && segments.length === 1 && FORBIDDEN_ROOT_FILES.has(segments[0].toLowerCase())) {
    return { ok: false, reason: `"${segments[0]}" controls what CI installs or runs` };
  }

  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...segments);
  const back = relative(absoluteRoot, absolute);
  if (back.length === 0 || back.startsWith('..') || isAbsolute(back)) {
    return { ok: false, reason: 'resolved path escapes the checkout' };
  }

  // Symlink escape: if any *existing* ancestor of the target is a symlink,
  // a write through it could land anywhere. Non-existent ancestors are fine
  // (they will be created as real directories by the writer).
  let cursor = absoluteRoot;
  for (const seg of segments.slice(0, -1)) {
    cursor = `${cursor}${sep}${seg}`;
    try {
      if (lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: `"${seg}" is a symbolic link` };
    } catch {
      break; // does not exist yet — nothing below it can be a symlink either
    }
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) return { ok: false, reason: 'target is a symbolic link' };
  } catch {
    // does not exist — a fresh file, fine
  }

  return { ok: true, absolute, relative: segments.join('/') };
}

export default { checkRepoRelativePath };
