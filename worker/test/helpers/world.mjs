// A fake world for Worker tests: a GitHub API that holds real sealed boxes, providers that answer by key, a DNS over HTTPS
// answer, and a fetch that routes by host. The same handlers also run behind a local http server for the workerd tests.
// Nothing here ever logs a header, because a header can carry a key.
import nacl from 'tweetnacl';
import sealedbox from 'tweetnacl-sealedbox-js';
import { makeD1 } from './d1.mjs';

export const ADMIN = ['admin', 'token', 'for', 'tests', '0123456789'].join('-');
export const OTHER_ADMIN = ['some', 'other', 'wrong', 'token', 'value'].join('-');
/** A made-up key. It is built from parts so that no key shaped literal sits in the source. */
export const FAKE_GROQ_KEY = ['gsk', 'x'.repeat(8), 'FAKE', 'y'.repeat(24)].join('_');
export const FAKE_GEMINI_KEY = ['AIza', 'Sy', 'F'.repeat(10), 'fake', 'z'.repeat(15)].join('');

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

export class FakeGitHub {
  constructor({ owner = 'shreyas-tech7', repo = 'TITAN-Runner' } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.keyPair = nacl.box.keyPair();
    this.keyId = 'key-1';
    /** @type {Map<string, { encrypted_value: string, key_id: string, created_at: string, updated_at: string }>} */
    this.secrets = new Map();
    this.dispatches = [];
    this.deleted = [];
    this.comments = [];
    this.issues = [];
    this.variables = new Map();
    this.files = new Map();
    /** Force a failure: { publicKey: 403, put: 500, list: 403, dispatch: 422, delete: 500 }. */
    this.fail = {};
    this.workflowRuns = [];
  }

  /** Put a secret the way a person does in the GitHub UI. */
  setByHand(name, plain, updatedAt = '2026-09-03T01:21:06Z') {
    const sealed = sealedbox.seal(new TextEncoder().encode(plain), this.keyPair.publicKey);
    this.secrets.set(name, { encrypted_value: b64(sealed), key_id: this.keyId, created_at: updatedAt, updated_at: updatedAt });
  }

  /** Open a stored secret with the private key, like a runner does. */
  open(name) {
    const s = this.secrets.get(name);
    if (!s) return null;
    const opened = sealedbox.open(new Uint8Array(Buffer.from(s.encrypted_value, 'base64')), this.keyPair.publicKey, this.keyPair.secretKey);
    return opened ? new TextDecoder().decode(opened) : null;
  }

  async handle(request) {
    const url = new URL(request.url);
    const base = `/repos/${this.owner}/${this.repo}`;
    const p = url.pathname;
    const m = request.method;
    if (this.fail.all) return json({ message: 'Server error' }, this.fail.all);
    if (!p.startsWith(base)) return json({ message: 'Not Found' }, 404);
    const rest = p.slice(base.length);
    if (m === 'GET' && rest === '/actions/secrets/public-key') {
      if (this.fail.publicKey) return json({ message: 'Resource not accessible by personal access token' }, this.fail.publicKey, { 'x-github-request-id': 'FAKE:0001' });
      return json({ key: b64(this.keyPair.publicKey), key_id: this.keyId });
    }
    if (m === 'GET' && rest === '/actions/secrets') {
      if (this.fail.list) return json({ message: 'Resource not accessible by personal access token' }, this.fail.list);
      const secrets = [...this.secrets.entries()].map(([name, s]) => ({ name, created_at: s.created_at, updated_at: s.updated_at }));
      return json({ total_count: secrets.length, secrets });
    }
    const named = rest.match(/^\/actions\/secrets\/([A-Z0-9_]+)$/);
    if (named && m === 'PUT') {
      if (this.fail.put) return json({ message: 'boom' }, this.fail.put);
      const body = await request.json();
      const existed = this.secrets.has(named[1]);
      const now = new Date().toISOString();
      this.secrets.set(named[1], { encrypted_value: body.encrypted_value, key_id: body.key_id, created_at: existed ? this.secrets.get(named[1]).created_at : now, updated_at: now });
      return new Response(null, { status: existed ? 204 : 201 });
    }
    if (named && m === 'DELETE') {
      if (this.fail.delete) return json({ message: 'boom' }, this.fail.delete);
      if (!this.secrets.has(named[1])) return json({ message: 'Not Found' }, 404);
      this.secrets.delete(named[1]);
      this.deleted.push(named[1]);
      return new Response(null, { status: 204 });
    }
    if (m === 'POST' && rest === '/dispatches') {
      if (this.fail.dispatch) return json({ message: 'Validation Failed' }, this.fail.dispatch);
      const body = await request.json();
      this.dispatches.push({ event_type: body.event_type, client_payload: body.client_payload });
      return new Response(null, { status: 204 });
    }
    if (m === 'GET' && rest === '/issues') return json(this.issues);
    const issueComment = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (issueComment && m === 'POST') {
      const body = await request.json();
      this.comments.push({ issue: Number(issueComment[1]), body: body.body });
      return json({ id: this.comments.length }, 201);
    }
    const variable = rest.match(/^\/actions\/variables\/([A-Z0-9_]+)$/);
    if (variable && m === 'GET') return this.variables.has(variable[1]) ? json({ name: variable[1], value: this.variables.get(variable[1]) }) : json({ message: 'Not Found' }, 404);
    if (m === 'GET' && /^\/actions\/workflows\/[^/]+\/runs$/.test(rest)) return json({ workflow_runs: this.workflowRuns });
    return json({ message: 'Not Found' }, 404);
  }

  rawHandle(request) {
    const url = new URL(request.url);
    const prefix = `/${this.owner}/${this.repo}/main/`;
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 });
    const text = this.files.get(url.pathname.slice(prefix.length));
    return text === undefined ? new Response('not found', { status: 404 }) : new Response(text, { status: 200 });
  }
}

/** Providers that answer by key. Each host has sets of keys with a special behavior. */
export class FakeProviders {
  constructor() {
    /** @type {Map<string, { valid: Set<string>, rateLimited: Set<string>, serverError: Set<string>, slow: Set<string>, geminiStyle: boolean, chatStatus: number|null }>} */
    this.hosts = new Map();
    this.calls = [];
  }

  host(name, { geminiStyle = false } = {}) {
    if (!this.hosts.has(name)) this.hosts.set(name, { valid: new Set(), rateLimited: new Set(), serverError: new Set(), slow: new Set(), geminiStyle, chatStatus: null });
    return this.hosts.get(name);
  }

  async handle(request) {
    const url = new URL(request.url);
    const spec = this.hosts.get(url.hostname);
    this.calls.push({ host: url.hostname, method: request.method, path: url.pathname });
    if (!spec) return json({ error: 'unknown host' }, 404);
    const auth = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? request.headers.get('x-goog-api-key') ?? '';
    if (url.search.includes('key=')) return json({ error: 'a key in the query string is not allowed' }, 400);
    if (spec.slow.has(auth)) await new Promise((r) => setTimeout(r, spec.slowMs ?? 12_000));
    if (spec.serverError.has(auth)) return json({ error: { message: 'oops' } }, 500);
    if (spec.rateLimited.has(auth)) return json({ error: { message: 'slow down' } }, 429, { 'retry-after': '30' });
    if (!spec.valid.has(auth)) {
      if (spec.geminiStyle) return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
      return json({ error: { message: `Incorrect API key provided: ${auth.slice(0, 4)}***`, code: 'invalid_api_key' } }, 401);
    }
    if (request.method === 'POST' && /chat\/completions$/.test(url.pathname)) {
      if (spec.chatStatus) return json({ error: { message: 'chat failed' } }, spec.chatStatus);
      const body = await request.json().catch(() => ({}));
      if (body.stream) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            for (const piece of ['Hel', 'lo ', 'there']) controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return json({ model: body.model ?? 'fake-model', choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 7 } });
    }
    if (request.method === 'POST' && /:generateContent$/.test(url.pathname)) return json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { totalTokenCount: 7 } });
    return json({ object: 'list', data: [{ id: 'fake-model-a' }, { id: 'fake-model-b' }] });
  }
}

/** Everything together. Install `world.fetch` as the global fetch, or serve `world.handle` over http. */
export class FakeWorld {
  constructor(opts = {}) {
    this.github = new FakeGitHub(opts);
    this.providers = new FakeProviders();
    this.extraHosts = new Map();
    /** Addresses that the DNS fake returns for a host. The default is a public address. */
    this.dns = new Map();
    /** @type {Array<{ host: string, method: string, path: string }>} */
    this.log = [];
    this.fetch = (input, init) => this.handle(new Request(typeof input === 'string' ? input : input.url ?? String(input), init));
    for (const h of ['api.groq.com', 'api.together.xyz', 'openrouter.ai', 'huggingface.co', 'router.huggingface.co', 'llm.example.com', 'gw.example.com', 'hermes.example.com']) this.providers.host(h);
    this.providers.host('generativelanguage.googleapis.com', { geminiStyle: true });
  }

  addHost(host, handler) {
    this.extraHosts.set(host, handler);
  }

  /** Like a real fetch: a call that is aborted, for example by a timeout, rejects at once. */
  async handle(request) {
    const work = this.#route(request);
    if (!request.signal) return work;
    return Promise.race([
      work,
      new Promise((_, reject) => {
        const fail = () => reject(request.signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        if (request.signal.aborted) fail();
        else request.signal.addEventListener('abort', fail, { once: true });
      }),
    ]);
  }

  async #route(request) {
    const url = new URL(request.url);
    this.log.push({ host: url.hostname, method: request.method, path: url.pathname });
    if (url.hostname === 'api.github.com') return this.github.handle(request);
    if (url.hostname === 'raw.githubusercontent.com') return this.github.rawHandle(request);
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      const answers = this.dns.get(name) ?? ['93.184.216.34'];
      const list = type === 'A' ? answers.filter((a) => !a.includes(':')) : answers.filter((a) => a.includes(':'));
      return json({ Status: 0, Answer: list.map((data) => ({ name, type: type === 'A' ? 1 : 28, data })) });
    }
    if (this.extraHosts.has(url.hostname)) return this.extraHosts.get(url.hostname)(request);
    if (this.providers.hosts.has(url.hostname)) return this.providers.handle(request);
    return new Response(`no fake for ${url.hostname}`, { status: 502 });
  }

  /** @param {import('node:test').TestContext} t */
  install(t) {
    t.mock.method(globalThis, 'fetch', this.fetch);
    return this;
  }

  /** A Worker env with a migrated database. */
  env(extra = {}) {
    return {
      TITAN_ADMIN_TOKEN: ADMIN,
      GITHUB_OWNER: this.github.owner,
      GITHUB_REPO: this.github.repo,
      GITHUB_PAT: 'fake-pat-for-tests',
      DB: makeD1(),
      ...extra,
    };
  }

  /** The hosts that a request reached, in order, as `host METHOD path`. */
  trail() {
    return this.log.filter((l) => l.host !== 'cloudflare-dns.com').map((l) => `${l.host} ${l.method} ${l.path}`);
  }
}

export const post = (path, body, headers = {}) =>
  new Request(`https://worker.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
export const get = (path, headers = {}) => new Request(`https://worker.example${path}`, { method: 'GET', headers });
export const del = (path, body, headers = {}) =>
  new Request(`https://worker.example${path}`, { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
export const authed = { 'X-Titan-Auth': ADMIN };

/** Capture console.log and console.error of a test. Returns a function that gives the text. */
export function captureConsole(t) {
  const lines = [];
  for (const level of ['log', 'error', 'warn', 'info']) t.mock.method(console, level, (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  return () => lines.join('\n');
}
