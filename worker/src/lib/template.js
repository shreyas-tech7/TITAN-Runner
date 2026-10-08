/**
 * @file The request template engine of the connector broker (Wave 12, C1).
 *
 * A template holds references in double braces: `{{input.name}}`, `{{config.name}}`, and `{{secret.name}}`.
 *   - `input` is what the caller sent, after the JSON Schema check and the defaults.
 *   - `config` is a non-secret field of the connection, such as a repository name.
 *   - `secret` is a secret field of the connection. A secret may appear in a header value only.
 * Rules that the engine enforces:
 *   - A value in a URL path or in a query string is URL encoded. The filter `|raw` turns that off, and only a vetted
 *     config value such as a base URL may use it.
 *   - A body is a JSON object. A string that is exactly one reference keeps the native type of the value. A reference inside
 *     a longer string becomes text.
 *   - A reference to a value that does not exist is an error. The engine never writes "undefined".
 *   - A secret in a URL, a query string, or a body is an error.
 */

const REF = /\{\{\s*([a-z]+)\.([A-Za-z0-9_.-]+)\s*(?:\|\s*(raw))?\s*\}\}/g;
const ONLY_REF = /^\{\{\s*([a-z]+)\.([A-Za-z0-9_.-]+)\s*(?:\|\s*(raw))?\s*\}\}$/;

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

function lookup(ctx, scope, path) {
  if (!['input', 'config', 'secret', 'body'].includes(scope)) throw new TemplateError(`unknown reference scope "${scope}"`);
  let cur = ctx[scope];
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) throw new TemplateError(`no value for {{${scope}.${path}}}`);
    cur = cur[part];
  }
  if (cur === undefined) throw new TemplateError(`no value for {{${scope}.${path}}}`);
  return cur;
}

function asText(value, ref) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TemplateError(`{{${ref}}} is not a simple value`);
}

/** Every reference in a template value, as `scope.path` strings. */
export function findRefs(value, out = []) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(REF)) out.push(`${m[1]}.${m[2]}`);
  } else if (Array.isArray(value)) value.forEach((v) => findRefs(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => findRefs(v, out));
  return out;
}

/**
 * Expand one string.
 * @param {string} template
 * @param {Record<string, any>} ctx
 * @param {'text'|'path'|'query'|'header'} mode `path` and `query` URL encode each value.
 */
export function expandString(template, ctx, mode = 'text') {
  return template.replace(REF, (_all, scope, path, filter) => {
    const text = asText(lookup(ctx, scope, path), `${scope}.${path}`);
    if (mode === 'path' || mode === 'query') return filter === 'raw' ? text : encodeURIComponent(text);
    return text;
  });
}

/** Expand a body tree. A string that is exactly one reference keeps its native type. */
export function expandDeep(value, ctx) {
  if (typeof value === 'string') {
    const only = value.match(ONLY_REF);
    if (only) return lookup(ctx, only[1], only[2]);
    return expandString(value, ctx, 'text');
  }
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // An optional input that the caller left out drops its key. A required one is checked by the schema before this runs.
      if (typeof v === 'string') {
        const only = v.match(ONLY_REF);
        if (only && only[1] === 'input') {
          try {
            lookup(ctx, only[1], only[2]);
          } catch (err) {
            if (err instanceof TemplateError) continue;
            throw err;
          }
        }
      }
      out[k] = expandDeep(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Check the placement rules of a request spec without any values. Returns a list of problems.
 * @param {{ url?: string, query?: Record<string,string>, headers?: Record<string,string>, body?: unknown }} request
 * @param {{ allowSecretInQuery?: boolean }} [opts]
 */
export function checkRequestSpec(request, opts = {}) {
  const problems = [];
  for (const ref of findRefs(request.url ?? '')) if (ref.startsWith('secret.')) problems.push(`the url holds {{${ref}}}. A secret may appear in a header only`);
  for (const ref of [...findRefs(request.body ?? null), ...findRefs(request.bodyText ?? '')]) if (ref.startsWith('secret.')) problems.push(`the body holds {{${ref}}}. A secret may appear in a header only`);
  if (!opts.allowSecretInQuery) for (const ref of findRefs(request.query ?? {})) if (ref.startsWith('secret.')) problems.push(`the query holds {{${ref}}}. A secret may appear in a header only`);
  for (const ref of [...findRefs(request.url ?? ''), ...findRefs(request.query ?? {}), ...findRefs(request.headers ?? {}), ...findRefs(request.body ?? null), ...findRefs(request.bodyText ?? '')]) {
    const scope = ref.split('.')[0];
    if (!['input', 'config', 'secret'].includes(scope)) problems.push(`unknown reference {{${ref}}}`);
  }
  return problems;
}

/**
 * Build a request from a spec.
 * @returns {{ method: string, url: string, headers: Record<string,string>, body: string|undefined, contentType: string|null }}
 */
export function buildRequest(spec, ctx) {
  const method = (spec.method ?? 'GET').toUpperCase();
  let url = expandString(spec.url, ctx, 'path');
  const query = Object.entries(spec.query ?? {}).flatMap(([k, v]) => {
    // A query value that is one reference and is missing is skipped. This is how an optional input works.
    // A list gives the same key more than once.
    try {
      const values = Array.isArray(v) ? v : [v];
      return values.map((item) => `${encodeURIComponent(k)}=${expandString(String(item), ctx, 'query')}`);
    } catch (err) {
      if (err instanceof TemplateError && /^no value for \{\{input\./.test(err.message)) return [];
      throw err;
    }
  });
  if (query.length > 0) url += `${url.includes('?') ? '&' : '?'}${query.join('&')}`;
  const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expandString(String(v), ctx, 'header')]));
  let body;
  let contentType = null;
  if (spec.bodyText !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = expandString(String(spec.bodyText), ctx, 'text');
    contentType = 'text/plain; charset=utf-8';
  } else if (spec.body !== undefined && spec.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = JSON.stringify(expandDeep(spec.body, ctx));
    contentType = 'application/json';
  }
  return { method, url, headers, body, contentType };
}
