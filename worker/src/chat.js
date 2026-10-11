/**
 * @file Instant chat in the Worker (Wave 12, A1 and X21).
 *
 * Calls a model provider directly with an encrypted vault key that a person marked "also for chat".
 * Streams Server-Sent Events back to the browser and stores threads in D1 (`chat_threads`, `chat_messages`).
 * On a 429, a 5xx, or a timeout before the first token, it tries the next chat provider in order.
 */
import { PROVIDERS, getProvider } from './lib/catalog.js';
import { getSetting, setSetting } from './lib/db.js';
import { SafeFetchError, safeFetch } from './lib/safeFetch.js';
import { getVaultPlaintext, vaultReady } from './lib/vault.js';
import { json, jsonError, nowIso, randomHex, readJson } from './lib/util.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** List the providers that have an encrypted chat key in the vault, in failover order. */
export async function listChatCandidates(env, preferredProvider = null) {
  if (!vaultReady(env)) return [];
  const { results } = await env.DB.prepare('SELECT provider, proof_model FROM provider_keys WHERE also_for_chat = 1').all();
  const enabled = new Map((results ?? []).map((r) => [r.provider, r]));
  if (enabled.size === 0) return [];

  let order = PROVIDERS.filter((p) => p.usedBy.includes('chat') && p.chat).map((p) => p.id);
  const customOrderRaw = await getSetting(env, 'chat.providerOrder').catch(() => null);
  if (customOrderRaw) {
    try {
      const parsed = JSON.parse(customOrderRaw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((id) => order.includes(id));
        const rest = order.filter((id) => !valid.includes(id));
        order = [...valid, ...rest];
      }
    } catch {
      // ignore invalid setting
    }
  }
  if (preferredProvider && order.includes(preferredProvider)) {
    order = [preferredProvider, ...order.filter((id) => id !== preferredProvider)];
  }

  const out = [];
  for (const id of order) {
    if (!enabled.has(id)) continue;
    const entry = getProvider(id);
    if (!entry?.chat) continue;
    let key = null;
    try {
      key = await getVaultPlaintext(env, { id: `provider-key:${id}`, connectionId: `providerkey:${id}`, connectorId: 'provider-key' });
    } catch {
      key = null;
    }
    if (!key) continue;
    let inputs = {};
    const rawInputs = await getSetting(env, `chat.inputs.${id}`).catch(() => null);
    if (rawInputs) {
      try {
        inputs = JSON.parse(rawInputs) ?? {};
      } catch {
        inputs = {};
      }
    }
    const row = enabled.get(id);
    const model = inputs.model || row?.proof_model || entry.chat.defaultModel || 'auto';
    const baseTpl = entry.chat.baseUrl || '';
    const baseUrl = baseTpl.replace('{baseUrl}', (inputs.baseUrl || entry.inputs?.baseUrl?.default || '').replace(/\/+$/, '')).replace(/\/+$/, '');
    if (!baseUrl || !hostOf(baseUrl)) continue;
    out.push({
      id: entry.id,
      label: inputs.label || entry.label,
      style: entry.chat.style,
      baseUrl,
      path: (entry.chat.path || '/chat/completions').replace('{chatPath}', inputs.chatPath || '/v1/chat/completions'),
      streamPath: entry.chat.streamPath || null,
      model,
      key,
    });
  }
  return out;
}

function buildRequestForCandidate(candidate, messages, { stream, maxTokens = 1024 }) {
  const host = hostOf(candidate.baseUrl);
  if (candidate.style === 'gemini') {
    const modelPath = (stream && candidate.streamPath ? candidate.streamPath : candidate.path).replace('{model}', encodeURIComponent(candidate.model));
    const url = `${candidate.baseUrl}${modelPath}`;
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content ?? '') }],
      }));
    const body = {
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    };
    return {
      url,
      host,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream, application/json' : 'application/json',
          'x-goog-api-key': candidate.key,
        },
        body: JSON.stringify(body),
      },
    };
  }

  const url = `${candidate.baseUrl}${candidate.path}`;
  return {
    url,
    host,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream, application/json' : 'application/json',
        authorization: `Bearer ${candidate.key}`,
      },
      body: JSON.stringify({
        model: candidate.model,
        messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
        stream: Boolean(stream),
        max_tokens: maxTokens,
      }),
    },
  };
}

function parseJsonAnswer(candidate, body) {
  if (candidate.style === 'gemini') {
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('');
    const tokensUsed = body?.usageMetadata?.totalTokenCount ?? null;
    return { text, tokensUsed, model: candidate.model };
  }
  const text = body?.choices?.[0]?.message?.content ?? '';
  const tokensUsed = body?.usage?.total_tokens ?? null;
  return { text: String(text ?? ''), tokensUsed, model: body?.model ?? candidate.model };
}

function extractSseChunk(candidate, dataLine) {
  if (!dataLine || dataLine === '[DONE]') return { done: dataLine === '[DONE]', text: '', tokensUsed: null };
  let parsed;
  try {
    parsed = JSON.parse(dataLine);
  } catch {
    return { done: false, text: '', tokensUsed: null };
  }
  if (candidate.style === 'gemini') {
    const text = (parsed?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('');
    const tokensUsed = parsed?.usageMetadata?.totalTokenCount ?? null;
    return { done: false, text, tokensUsed };
  }
  const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? '';
  const tokensUsed = parsed?.usage?.total_tokens ?? null;
  return { done: false, text: String(delta ?? ''), tokensUsed };
}

async function consumeProviderStream(res, candidate, onDelta) {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.includes('text/event-stream') || !res.body) {
    const body = await res.json().catch(() => ({}));
    const out = parseJsonAnswer(candidate, body);
    if (out.text) onDelta(out.text);
    return out;
  }
  const reader = res.body.getReader();
  let buf = '';
  let fullText = '';
  let tokensUsed = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        const piece = extractSseChunk(candidate, payload);
        if (piece.tokensUsed !== null) tokensUsed = piece.tokensUsed;
        if (piece.text) {
          fullText += piece.text;
          onDelta(piece.text);
        }
        if (piece.done) return { text: fullText, tokensUsed, model: candidate.model };
      }
    }
    if (buf.trim().startsWith('data:')) {
      const piece = extractSseChunk(candidate, buf.trim().slice(5).trim());
      if (piece.tokensUsed !== null) tokensUsed = piece.tokensUsed;
      if (piece.text) {
        fullText += piece.text;
        onDelta(piece.text);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text: fullText, tokensUsed, model: candidate.model };
}

async function saveExchange(env, { threadId, title, userText, assistantText, provider, model, tokensUsed }) {
  const now = nowIso();
  const tid = threadId || `th_${randomHex(8)}`;
  const userMsgId = `m_${randomHex(8)}`;
  const asstMsgId = `m_${randomHex(8)}`;
  await env.DB.prepare(
    `INSERT INTO chat_threads (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at`,
  )
    .bind(tid, title, provider, model, now, now)
    .run();
  await env.DB.prepare('INSERT INTO chat_messages (id, thread_id, role, content, provider, model, tokens_used, at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)')
    .bind(userMsgId, tid, 'user', userText, now)
    .run();
  await env.DB.prepare('INSERT INTO chat_messages (id, thread_id, role, content, provider, model, tokens_used, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(asstMsgId, tid, 'assistant', assistantText, provider, model, tokensUsed, nowIso(new Date(Date.now() + 1)))
    .run();
  return { threadId: tid, messageId: asstMsgId };
}

/**
 * Run one non-streaming chat turn in the Worker (used by Telegram /chat, the daily brief, and non-stream POST /chat).
 */
export async function runInstantChat(env, { prompt, threadId = null, provider = null, system = null }) {
  const candidates = await listChatCandidates(env, provider);
  if (candidates.length === 0) {
    return { ok: false, error: 'no_chat_key', message: 'No provider key is marked for chat. Open the Keys page and check "Also store in the Worker vault for instant chat".' };
  }
  const history = [];
  if (system) history.push({ role: 'system', content: system });
  if (threadId) {
    const { results } = await env.DB.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY at ASC LIMIT 20').bind(threadId).all();
    for (const r of results ?? []) history.push({ role: r.role, content: r.content });
  }
  history.push({ role: 'user', content: prompt });

  const errors = [];
  for (const candidate of candidates) {
    const req = buildRequestForCandidate(candidate, history, { stream: false, maxTokens: 1024 });
    try {
      const res = await safeFetch(env, req.url, req.init, { allow: [req.host], timeoutMs: 12_000, maxBytes: 500_000 });
      if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
        errors.push(`${candidate.id}: HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        errors.push(`${candidate.id}: HTTP ${res.status}`);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const out = parseJsonAnswer(candidate, body);
      if (!out.text.trim()) {
        errors.push(`${candidate.id}: empty answer`);
        continue;
      }
      const title = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';
      const saved = await saveExchange(env, {
        threadId,
        title,
        userText: prompt,
        assistantText: out.text,
        provider: candidate.id,
        model: out.model,
        tokensUsed: out.tokensUsed,
      });
      return {
        ok: true,
        threadId: saved.threadId,
        messageId: saved.messageId,
        text: out.text,
        provider: candidate.id,
        model: out.model,
        tokensUsed: out.tokensUsed,
      };
    } catch (err) {
      errors.push(`${candidate.id}: ${err instanceof SafeFetchError ? err.code : 'failed'}`);
    }
  }
  return { ok: false, error: 'all_providers_failed', message: `All chat providers failed (${errors.join(', ')}).` };
}

/** POST /chat: streams Server-Sent Events (or returns JSON when stream === false). */
export async function handleChat(c) {
  const { env, requestId } = c;
  const parsed = await readJson(c.request, 32_768);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const prompt = typeof body.message === 'string' ? body.message.trim() : typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return jsonError(400, 'missing_message', 'Write a message to send.', { requestId });
  if (prompt.length > 8000) return jsonError(400, 'message_too_long', 'The message is too long (maximum 8000 characters).', { requestId });

  const threadId = typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : null;
  const preferred = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : null;
  const wantStream = body.stream !== false;

  if (!wantStream) {
    const res = await runInstantChat(env, { prompt, threadId, provider: preferred });
    if (!res.ok) return jsonError(res.error === 'no_chat_key' ? 409 : 502, res.error, res.message, { requestId });
    return json({ ...res, requestId });
  }

  const candidates = await listChatCandidates(env, preferred);
  if (candidates.length === 0) {
    return jsonError(409, 'no_chat_key', 'No provider key is marked for chat. Open the Keys page and check "Also store in the Worker vault for instant chat".', { requestId });
  }

  const history = [];
  if (threadId) {
    const { results } = await env.DB.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY at ASC LIMIT 20').bind(threadId).all();
    for (const r of results ?? []) history.push({ role: r.role, content: r.content });
  }
  history.push({ role: 'user', content: prompt });

  const errors = [];
  let chosen = null;
  let upstream = null;
  for (const candidate of candidates) {
    const req = buildRequestForCandidate(candidate, history, { stream: true, maxTokens: 1024 });
    try {
      const res = await safeFetch(env, req.url, req.init, { allow: [req.host], timeoutMs: 12_000, maxBytes: 1_000_000 });
      if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403 || !res.ok) {
        errors.push(`${candidate.id}: HTTP ${res.status}`);
        continue;
      }
      chosen = candidate;
      upstream = res;
      break;
    } catch (err) {
      errors.push(`${candidate.id}: ${err instanceof SafeFetchError ? err.code : 'failed'}`);
    }
  }

  if (!chosen || !upstream) {
    return jsonError(502, 'all_providers_failed', `All chat providers failed (${errors.join(', ')}).`, { requestId });
  }

  const tid = threadId || `th_${randomHex(8)}`;
  const title = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        sendEvent('meta', { threadId: tid, provider: chosen.id, model: chosen.model, requestId });
        const out = await consumeProviderStream(upstream, chosen, (delta) => {
          sendEvent('delta', { text: delta });
        });
        const saved = await saveExchange(env, {
          threadId: tid,
          title,
          userText: prompt,
          assistantText: out.text,
          provider: chosen.id,
          model: out.model,
          tokensUsed: out.tokensUsed,
        });
        sendEvent('done', {
          threadId: saved.threadId,
          messageId: saved.messageId,
          provider: chosen.id,
          model: out.model,
          tokensUsed: out.tokensUsed,
          text: out.text,
        });
      } catch (err) {
        sendEvent('error', { error: 'stream_failed', message: err instanceof Error ? err.message : 'The stream failed.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** GET /chat/threads */
export async function handleListChatThreads(c) {
  const { env, requestId } = c;
  const { results: threads } = await env.DB.prepare('SELECT id, title, provider, model, created_at, updated_at FROM chat_threads ORDER BY updated_at DESC LIMIT 50').all();
  const candidates = await listChatCandidates(env);
  return json({
    ready: candidates.length > 0,
    vaultReady: vaultReady(env),
    providers: candidates.map((p) => ({ id: p.id, label: p.label, model: p.model })),
    threads: threads ?? [],
    requestId,
  });
}

/** GET /chat/threads/:id */
export async function handleGetChatThread(c) {
  const { env, params, requestId } = c;
  const thread = await env.DB.prepare('SELECT id, title, provider, model, created_at, updated_at FROM chat_threads WHERE id = ?').bind(params.id).first();
  if (!thread) return jsonError(404, 'not_found', 'This chat thread does not exist.', { requestId });
  const { results: messages } = await env.DB.prepare('SELECT id, thread_id, role, content, provider, model, tokens_used, at FROM chat_messages WHERE thread_id = ? ORDER BY at ASC').bind(params.id).all();
  return json({ thread, messages: messages ?? [], requestId });
}

/** DELETE /chat/threads/:id */
export async function handleDeleteChatThread(c) {
  const { env, params, requestId } = c;
  await env.DB.prepare('DELETE FROM chat_messages WHERE thread_id = ?').bind(params.id).run();
  const res = await env.DB.prepare('DELETE FROM chat_threads WHERE id = ?').bind(params.id).run();
  if ((res.meta?.changes ?? 0) === 0) return jsonError(404, 'not_found', 'This chat thread does not exist.', { requestId });
  return json({ ok: true, deleted: params.id, requestId });
}

/** DELETE /chat/threads */
export async function handleClearChatThreads(c) {
  const { env, requestId } = c;
  await env.DB.prepare('DELETE FROM chat_messages').run();
  const res = await env.DB.prepare('DELETE FROM chat_threads').run();
  return json({ ok: true, deletedThreads: res.meta?.changes ?? 0, requestId });
}

/** POST /chat/order (X21: user-set provider order for chat) */
export async function handleSetChatOrder(c) {
  const parsed = await readJson(c.request, 4096);
  if (!parsed.ok) return parsed.response;
  const order = Array.isArray(parsed.value.order) ? parsed.value.order.map(String) : null;
  if (!order || order.length === 0) return jsonError(400, 'invalid_order', 'Provide an array of provider ids.', { requestId: c.requestId });
  await setSetting(c.env, 'chat.providerOrder', JSON.stringify(order));
  return json({ ok: true, order, requestId: c.requestId });
}
