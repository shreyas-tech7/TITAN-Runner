/**
 * @file A deliberately tiny YAML-subset parser for this repo's own config
 * files (`config/safety-rules.yml`, `config/research-topics.yml`). Like
 * `taskYaml.js`, it exists because this repo is dependency-free; it is NOT
 * a general YAML library and rejects anything outside the subset instead of
 * guessing.
 *
 * The subset:
 *   - `# comment` lines, blank lines, and trailing ` # comment` after a value
 *   - top-level `key: scalar`
 *   - top-level `key:` followed by EITHER an indented list of scalars
 *     (`  - item`) OR an indented map of scalars (`  sub-key: scalar`)
 *   - scalars: "double quoted" (JSON escapes), 'single quoted', true/false,
 *     null, numbers, or a bare string
 *
 * Not supported (throws `YamlSubsetError` with the line number): tabs for
 * indentation, nesting deeper than one level, lists of maps, multi-line
 * scalars, anchors/aliases, flow collections, duplicate keys.
 */

export class YamlSubsetError extends Error {
  /** @param {string} message @param {number} line 1-based */
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlSubsetError';
    this.line = line;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;
const SUB_KEY = /^([A-Za-z0-9_][\w.-]*):\s+(.*)$/;

/** Remove a trailing ` # comment` that is not inside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** @param {string} raw @param {number} line */
function parseScalar(raw, line) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new YamlSubsetError('unterminated double-quoted string', line);
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlSubsetError('invalid escape in double-quoted string', line);
    }
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw new YamlSubsetError('unterminated single-quoted string', line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[[{&*!|>]/.test(s)) throw new YamlSubsetError(`unsupported YAML construct: ${s.slice(0, 20)}`, line);
  return s;
}

/**
 * @param {string} text
 * @returns {Record<string, string|number|boolean|null|Array<string|number|boolean|null>|Record<string, string|number|boolean|null>>}
 */
export function parseYamlSubset(text) {
  const out = Object.create(null);
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {{ key: string, kind: null|'list'|'map' }|null} */
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (/^ *\t/.test(raw)) throw new YamlSubsetError('tabs are not allowed for indentation', lineNo);
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    const body = stripped.trim();

    if (indent === 0) {
      const m = body.match(TOP_KEY);
      if (!m) throw new YamlSubsetError(`expected "key: value" or "key:", got: ${body.slice(0, 40)}`, lineNo);
      const [, key, rest] = m;
      if (FORBIDDEN_KEYS.has(key)) throw new YamlSubsetError(`forbidden key: ${key}`, lineNo);
      if (key in out) throw new YamlSubsetError(`duplicate key: ${key}`, lineNo);
      if (rest === undefined || rest.trim() === '') {
        out[key] = null;
        current = { key, kind: null };
      } else {
        out[key] = parseScalar(rest, lineNo);
        current = null;
      }
      continue;
    }

    if (!current) throw new YamlSubsetError('indented line with no parent key', lineNo);

    if (body === '-' || body.startsWith('- ')) {
      if (current.kind === 'map') throw new YamlSubsetError('cannot mix list items and map entries', lineNo);
      const item = body === '-' ? '' : body.slice(2).trim();
      if (item === '') throw new YamlSubsetError('empty list item', lineNo);
      // "- key: value" would be a list of maps, which this subset refuses
      // rather than silently parsing as a string.
      if (!/^["']/.test(item) && /:\s/.test(item)) throw new YamlSubsetError('lists of maps are not supported', lineNo);
      if (current.kind === null) {
        out[current.key] = [];
        current.kind = 'list';
      }
      out[current.key].push(parseScalar(item, lineNo));
      continue;
    }

    const m = body.match(SUB_KEY);
    if (!m) throw new YamlSubsetError(`expected "key: value" or "- item", got: ${body.slice(0, 40)}`, lineNo);
    if (current.kind === 'list') throw new YamlSubsetError('cannot mix list items and map entries', lineNo);
    if (FORBIDDEN_KEYS.has(m[1])) throw new YamlSubsetError(`forbidden key: ${m[1]}`, lineNo);
    if (current.kind === null) {
      out[current.key] = Object.create(null);
      current.kind = 'map';
    }
    if (m[1] in out[current.key]) throw new YamlSubsetError(`duplicate key: ${m[1]}`, lineNo);
    out[current.key][m[1]] = parseScalar(m[2], lineNo);
  }
  return out;
}

export default parseYamlSubset;
