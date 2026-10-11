/**
 * @file Handlers for the few actions that a plain request template cannot describe (Wave 12, C1).
 *
 * A handler is pure. `build` turns the connection and the input into one HTTP request. `shape` turns the answer into a result.
 * The fixture tests run these the same way as a template action.
 *
 * Some handlers need more than one request, such as the MCP client. Those are "impure" handlers. The broker runs them,
 * and the names are listed in IMPURE_HANDLERS so the pure core can tell them apart.
 */
import { capSize } from './shape.js';

export const IMPURE_HANDLERS = new Set(['mcp_test', 'mcp_list_tools', 'mcp_call_tool']);

/** @param {string | undefined} name */
export function isImpureHandler(name) {
  return Boolean(name) && IMPURE_HANDLERS.has(/** @type {string} */ (name));
}

export class HandlerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HandlerError';
  }
}

// ---------------------------------------------------------------------
// RSS and Atom
// ---------------------------------------------------------------------

export const MAX_FEED_CHARS = 262_144;
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5';

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e] ?? m;
  });
}

/** Turn feed text into plain text: unwrap CDATA, drop markup, decode entities, collapse spaces, cut the length. */
export function cleanText(raw, max = 300) {
  let s = String(raw ?? '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function tagText(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

function safeLink(raw) {
  const v = cleanText(raw, 600);
  return /^https?:\/\/[^\s]+$/i.test(v) ? v : '';
}

function itemLink(block) {
  const text = safeLink(tagText(block, ['link']));
  if (text) return text;
  for (const m of block.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    const rel = attrs.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1];
    if (rel && rel !== 'alternate') continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
    const link = href ? safeLink(decodeEntities(href)) : '';
    if (link) return link;
  }
  return '';
}

/**
 * Read an RSS 2.0 or an Atom 1.0 feed with simple rules. No script runs, and no markup survives.
 * @param {string} text
 * @param {number} limit
 * @returns {{ title: string, items: Array<{ title: string, link: string, date: string, summary: string }>, total: number }}
 */
export function parseFeed(text, limit = 10) {
  const xml = String(text ?? '').slice(0, MAX_FEED_CHARS);
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  const blocks = [...xml.matchAll(itemRe)].map((m) => m[0]);
  const title = cleanText(tagText(xml.replace(itemRe, ''), ['title']), 200);
  const items = blocks.slice(0, limit).map((b) => ({
    title: cleanText(tagText(b, ['title']), 200),
    link: itemLink(b),
    date: cleanText(tagText(b, ['pubDate', 'published', 'updated', 'dc:date']), 60),
    summary: cleanText(tagText(b, ['description', 'summary', 'content:encoded', 'content']), 300),
  }));
  return { title, items, total: blocks.length };
}

function feedRequest(config) {
  if (!config.feed_url) throw new HandlerError('The feed address is missing.');
  return { method: 'GET', url: config.feed_url, headers: { Accept: FEED_ACCEPT }, body: undefined, contentType: null };
}

function feedShape(res, input, mode) {
  if (res.status !== 200) return { ok: false, status: res.status, error: `The feed answered ${res.status}.` };
  const feed = parseFeed(res.text, mode === 'test' ? 1 : (input.limit ?? 10));
  if (feed.total === 0) return { ok: false, status: res.status, error: 'The answer does not look like an RSS or an Atom feed.' };
  if (mode === 'test') return { ok: true, status: res.status, data: { title: feed.title, items: feed.total } };
  return { ok: true, status: res.status, data: { title: feed.title, items: feed.items } };
}

// ---------------------------------------------------------------------
// Custom REST API
// ---------------------------------------------------------------------

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'proxy-authorization', 'authorization', 'upgrade', 'te', 'trailer', 'expect', 'user-agent', 'x-forwarded-for', 'x-real-ip']);

function b64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

function restBase(config) {
  let base;
  try {
    base = new URL(config.base_url);
  } catch {
    throw new HandlerError('The base address is not valid.');
  }
  if (base.protocol !== 'https:') throw new HandlerError('The base address must use https.');
  if (base.username || base.password) throw new HandlerError('The base address must not hold a user name or a password.');
  if (base.search || base.hash) throw new HandlerError('The base address must hold no query and no fragment.');
  return base;
}

function restAuthHeaders(config, secrets) {
  const style = config.auth_style || 'bearer';
  const key = secrets.api_key;
  if (!key || style === 'none') return {};
  if (style === 'bearer') return { Authorization: `Bearer ${key}` };
  if (style === 'basic') return { Authorization: `Basic ${b64(`${config.username ?? ''}:${key}`)}` };
  if (style === 'header') {
    const name = config.header_name || 'X-Api-Key';
    if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-titan')) throw new HandlerError(`The header name "${name}" is not allowed.`);
    return { [name]: key };
  }
  throw new HandlerError(`The key style "${style}" is not known.`);
}

/** A path is allowed when it equals a prefix or sits below it. The prefix "/items" allows "/items/4" and refuses "/items2". */
export function pathAllowed(path, prefixesCsv) {
  const prefixes = String(prefixesCsv || '/').split(',').map((p) => p.trim()).filter(Boolean);
  return prefixes.some((p) => p === '/' || path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

function restUrl(base, path, query, prefixes) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new HandlerError('The path must start with one "/".');
  if (/[?#\\]/.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.')) throw new HandlerError('The path must not hold "..", "?", "#", or a backslash.');
  if (prefixes !== undefined && !pathAllowed(path, prefixes)) throw new HandlerError('The path is outside the allowed paths of this connection.');
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${prefix}${path}`, base.origin);
  if (url.origin !== base.origin) throw new HandlerError('The path leaves the host of the base address.');
  const pairs = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) throw new HandlerError(`The query value for "${k}" must be text, a number, or true or false.`);
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
    }
  }
  if (pairs.length > 20) throw new HandlerError('The query holds too many values.');
  return pairs.length > 0 ? `${url.origin}${url.pathname}?${pairs.join('&')}` : `${url.origin}${url.pathname}`;
}

function restShape(manifest, res) {
  if (![200, 201, 202, 204].includes(res.status)) {
    let msg;
    try {
      const j = JSON.parse(res.text);
      msg = j?.message ?? j?.error?.message ?? j?.error ?? j?.detail;
    } catch {
      msg = undefined;
    }
    return { ok: false, status: res.status, error: `${manifest.name} answered ${res.status}${typeof msg === 'string' ? `: ${msg.slice(0, 160)}` : ''}` };
  }
  if (!res.text) return { ok: true, status: res.status, data: { status: res.status } };
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = { text: res.text.slice(0, 8000) };
  }
  const capped = capSize(data);
  return { ok: true, status: res.status, data: capped.value, truncated: capped.truncated };
}

function restHandler(method, withBody) {
  return {
    build: ({ config, secrets, input }) => ({
      method,
      url: restUrl(restBase(config), input.path, input.query, config.path_prefixes),
      headers: restAuthHeaders(config, secrets),
      body: withBody && input.body !== undefined ? JSON.stringify(input.body) : undefined,
      contentType: withBody && input.body !== undefined ? 'application/json' : null,
    }),
    shape: (res, { manifest }) => restShape(manifest, res),
  };
}

// ---------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------

/** @type {Record<string, { build: (ctx: any) => any, shape: (res: any, ctx: any) => any }>} */
export const HANDLERS = {
  rss_test: { build: ({ config }) => feedRequest(config), shape: (res) => feedShape(res, {}, 'test') },
  rss_read: { build: ({ config }) => feedRequest(config), shape: (res, { input }) => feedShape(res, input ?? {}, 'read') },
  rest_test: {
    build: ({ config, secrets }) => ({ method: 'GET', url: restUrl(restBase(config), config.test_path || '/', {}), headers: restAuthHeaders(config, secrets), body: undefined, contentType: null }),
    shape: (res, { manifest }) => (res.status >= 200 && res.status < 400 ? { ok: true, status: res.status, data: { status: res.status } } : { ok: false, status: res.status, error: `${manifest?.name ?? 'The API'} answered ${res.status}` }),
  },
  rest_get: restHandler('GET', false),
  rest_post: restHandler('POST', true),
  rest_put: restHandler('PUT', true),
  rest_patch: restHandler('PATCH', true),
  rest_delete: restHandler('DELETE', false),
};
