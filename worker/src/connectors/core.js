/**
 * @file The pure core of the connector broker (Wave 12, C1 and C3). Nothing here touches D1, the vault, or the network.
 * That is why the fixture tests can run every connector against recorded answers.
 *
 *   - validateConnectFields: check what a person typed in the connect window against the manifest.
 *   - buildActionRequest: turn an action and an input into one HTTP request, with the auth of the connector applied.
 *   - shapeResponse: turn an answer into a result: check the status, parse it, keep only the `pick` fields, cap the size.
 */
import { CONNECTORS } from '../connectors.generated.js';
import { validate, withDefaults } from '../lib/jsonschema.js';
import { TemplateError, buildRequest, checkRequestSpec, expandString } from '../lib/template.js';
import { HANDLERS, isImpureHandler } from './handlers.js';
import { MAX_RESULT_BYTES, capSize, pick } from './shape.js';

export class ActionInputError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'ActionInputError';
    this.problems = problems;
  }
}

export const MAX_FIELD_LENGTH = 2000;

/** @param {string} id */
export function manifestById(id) {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

export function actionOf(manifest, actionId) {
  return manifest.actions.find((a) => a.id === actionId) ?? null;
}

/** The part of a manifest that the dashboard may see. */
export function publicManifest(m) {
  return {
    id: m.id, name: m.name, icon: m.icon ?? '', version: m.version, category: m.category, description: m.description, docsUrl: m.docsUrl, getKeyUrl: m.getKeyUrl ?? '',
    apiVersion: m.apiVersion ?? '',
    auth: { kind: m.auth.kind, setupNote: m.auth.setupNote ?? '', fields: m.auth.fields.map((f) => ({ name: f.name, label: f.label, secret: f.secret, optional: Boolean(f.optional), help: f.help ?? '', placeholder: f.placeholder ?? '', default: f.default ?? '' })), oauth: m.auth.oauth ? { scopes: m.auth.oauth.scopes } : undefined },
    egress: m.egress,
    testMode: m.test.mode,
    triggers: m.triggers ?? [],
    actions: m.actions.map((a) => ({ id: a.id, title: a.title, description: a.description ?? '', risk: a.risk, dataClass: a.dataClass, input: a.input ?? { type: 'object', properties: {} }, rateLimit: a.rateLimit ?? null })),
  };
}

/**
 * Check what a person typed.
 * @returns {{ ok: true, config: Record<string,string>, secrets: Record<string,string> } | { ok: false, errors: string[] }}
 */
export function validateConnectFields(manifest, fields) {
  const errors = [];
  const config = {};
  const secrets = {};
  const known = new Set(manifest.auth.fields.map((f) => f.name));
  for (const key of Object.keys(fields ?? {})) if (!known.has(key)) errors.push(`The field "${key}" is not part of ${manifest.name}.`);
  for (const f of manifest.auth.fields) {
    const raw = fields?.[f.name];
    let value = typeof raw === 'string' ? raw.trim() : '';
    if (!value && f.default) value = f.default;
    if (!value) {
      if (!f.optional) errors.push(`${f.label} is required.`);
      continue;
    }
    if (value.length > MAX_FIELD_LENGTH) errors.push(`${f.label} is too long.`);
    else if (/[\u0000-\u001f\u007f]/.test(value)) errors.push(`${f.label} holds a control character.`);
    else if (f.pattern && !new RegExp(f.pattern).test(value)) errors.push(`${f.label} does not look right.${f.help ? ` ${f.help}` : ''}`);
    (f.secret ? secrets : config)[f.name] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config, secrets };
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * The hosts that a call may reach. `dynamic` hosts come from what a person typed, so the broker checks their DNS answer too.
 * @returns {{ hosts: string[], dynamic: string[] }}
 */
export function allowedHosts(manifest, config, secrets) {
  const hosts = new Set(manifest.egress);
  const dynamic = new Set();
  const a = manifest.auth;
  if (a.baseUrlField && config?.[a.baseUrlField]) {
    const h = hostOf(config[a.baseUrlField]);
    if (h) dynamic.add(h);
  }
  if (a.kind === 'secret_url' && secrets?.url) {
    const h = hostOf(secrets.url);
    if (h && !manifest.egress.includes(h)) dynamic.add(h);
  }
  if (a.kind === 'mcp_remote' && config?.url) {
    const h = hostOf(config.url);
    if (h) dynamic.add(h);
  }
  return { hosts: [...hosts, ...dynamic], dynamic: [...dynamic] };
}

/** Check the URL that a person gave for a secret_url connector against the host allowlist of the manifest. */
export function checkSecretUrl(manifest, url) {
  const h = hostOf(url);
  if (!h) return 'The address is not valid.';
  if (!url.startsWith('https://')) return 'The address must use https.';
  const allow = manifest.auth.hostAllowlist;
  if (allow && !allow.some((a) => (a.startsWith('.') ? h === a.slice(1) || h.endsWith(a) : h === a))) return `The host ${h} is not one that ${manifest.name} uses.`;
  return null;
}

function b64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

/**
 * Build the HTTP request of an action.
 * @param {any} manifest
 * @param {any} action
 * @param {{ config: Record<string,string>, secrets: Record<string,string>, input: Record<string, any> }} args
 */
export function buildActionRequest(manifest, action, { config = {}, secrets = {}, input = {} }) {
  const merged = withDefaults(action.input ?? { type: 'object', properties: {} }, input);
  const problems = validate(action.input ?? { type: 'object', properties: {} }, merged);
  if (problems.length > 0) throw new ActionInputError(`The input for ${action.id} is not valid.`, problems);

  if (action.handler) return runHandlerBuild(manifest, action, { config, secrets, input: merged });

  const spec = action.request ?? {};
  const bad = checkRequestSpec(spec, { allowSecretInQuery: manifest.auth.kind === 'api_key_query' });
  if (bad.length > 0) throw new TemplateError(`The manifest of ${manifest.id} breaks a placement rule: ${bad[0]}`);

  const ctx = { input: merged, config, secret: secrets };
  const a = manifest.auth;
  let built;
  if (a.kind === 'secret_url') {
    built = buildRequest({ ...spec, url: secrets.url }, { ...ctx, secret: {} });
  } else if (a.kind === 'telegram_bot') {
    built = buildRequest({ ...spec, url: `https://api.telegram.org/bot${secrets.token}/${spec.telegram}` }, { ...ctx, secret: {} });
  } else {
    built = buildRequest(spec, ctx);
  }

  const headers = { ...built.headers };
  switch (a.kind) {
    case 'bearer':
      headers.Authorization = `Bearer ${secrets[a.fields.find((f) => f.secret)?.name ?? 'token']}`;
      break;
    case 'api_key_header':
      headers[a.header ?? 'Authorization'] = `${a.prefix ?? ''}${secrets[a.fields.find((f) => f.secret)?.name ?? 'api_key']}`;
      break;
    case 'basic':
      headers.Authorization = `Basic ${b64(`${secrets.username ?? config.username ?? ''}:${secrets.password ?? ''}`)}`;
      break;
    case 'oauth2_pkce':
      headers.Authorization = `Bearer ${secrets.access_token}`;
      break;
    case 'mcp_remote':
      if (secrets.token) headers.Authorization = `Bearer ${secrets.token}`;
      break;
    default:
      break;
  }
  if (a.kind === 'api_key_query') {
    const sep = built.url.includes('?') ? '&' : '?';
    built.url += `${sep}${encodeURIComponent(a.queryParam ?? 'key')}=${encodeURIComponent(secrets[a.fields.find((f) => f.secret)?.name ?? 'api_key'])}`;
  }
  if (built.contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = built.contentType;
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.Accept = 'application/json';
  return { method: built.method, url: built.url, headers, body: built.body, input: merged };
}

function finishRequest(built, headersIn, merged) {
  const headers = { ...headersIn, ...built.headers };
  if (built.contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = built.contentType;
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.Accept = 'application/json';
  return { method: built.method, url: built.url, headers, body: built.body, input: merged };
}

function runHandlerBuild(manifest, action, { config, secrets, input }) {
  if (isImpureHandler(action.handler)) throw new TemplateError(`The handler ${action.handler} needs the broker. It cannot run as a single request.`);
  const handler = HANDLERS[action.handler];
  if (!handler) throw new TemplateError(`The manifest of ${manifest.id} names an unknown handler "${action.handler}".`);
  return finishRequest(handler.build({ manifest, config, secrets, input }), {}, input);
}

/**
 * Build the request of the connection test.
 * @returns {{ method: string, url: string, headers: Record<string,string>, body?: string } | null} null when the test is not one request.
 */
export function buildTestRequest(manifest, { config = {}, secrets = {} }) {
  const t = manifest.test;
  if (t.mode === 'none') return null;
  if (t.handler) {
    if (isImpureHandler(t.handler)) return null;
    return runHandlerBuild(manifest, { id: 'test', handler: t.handler }, { config, secrets, input: {} });
  }
  if (t.mode !== 'request') return null;
  return buildActionRequest(manifest, { id: 'test', input: { type: 'object', properties: {} }, request: t.request }, { config, secrets, input: {} });
}

/** Turn the answer to the connection test into a result. */
export function shapeTestResponse(manifest, res) {
  const t = manifest.test;
  if (t.handler && HANDLERS[t.handler]) return HANDLERS[t.handler].shape(res, { manifest, input: {} });
  const expect = t.expect ?? {};
  const pseudo = { id: 'test', response: 'json', okStatus: expect.status ?? [200], pick: expect.pick, request: { graphql: Boolean(expect.noGraphqlErrors) } };
  return shapeResponse(manifest, pseudo, res);
}

/**
 * Turn an answer into a result.
 * @param {any} manifest
 * @param {any} action
 * @param {{ status: number, text: string, contentType?: string }} res
 * @returns {{ ok: boolean, status: number, data?: any, truncated?: boolean, error?: string }}
 */
export function shapeResponse(manifest, action, res) {
  if (action.handler && HANDLERS[action.handler]) return HANDLERS[action.handler].shape(res, { manifest, input: res.input ?? {} });
  const okStatus = action.okStatus ?? [200, 201, 202, 204];
  const mode = action.response ?? 'json';
  let parsed;
  if (mode === 'json' || (res.contentType ?? '').includes('json')) {
    try {
      parsed = res.text ? JSON.parse(res.text) : null;
    } catch {
      parsed = undefined;
    }
  }
  if (!okStatus.includes(res.status)) {
    const msg = parsed && typeof parsed === 'object' ? (parsed.message ?? parsed.error?.message ?? parsed.error ?? parsed.description ?? parsed.detail) : undefined;
    return { ok: false, status: res.status, error: `${manifest.name} answered ${res.status}${typeof msg === 'string' ? `: ${msg.slice(0, 160)}` : ''}` };
  }
  if (manifest.id === 'telegram' && parsed && parsed.ok === false) return { ok: false, status: res.status, error: `Telegram refused the call: ${String(parsed.description ?? '').slice(0, 160)}` };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.errors) && (action.request?.graphql || manifest.test?.expect?.noGraphqlErrors)) {
    return { ok: false, status: res.status, error: `${manifest.name} returned an error: ${String(parsed.errors[0]?.message ?? 'unknown').slice(0, 160)}` };
  }
  if (mode === 'status') return { ok: true, status: res.status, data: { status: res.status } };
  if (mode === 'text') {
    const capped = capSize({ text: res.text.slice(0, MAX_RESULT_BYTES) });
    return { ok: true, status: res.status, data: capped.value, truncated: capped.truncated };
  }
  if (parsed === undefined) return { ok: false, status: res.status, error: `${manifest.name} did not return JSON.` };
  const picked = pick(parsed, action.pick);
  const capped = capSize(picked);
  return { ok: true, status: res.status, data: capped.value, truncated: capped.truncated };
}

export { MAX_RESULT_BYTES, capSize, expandString, pick };
