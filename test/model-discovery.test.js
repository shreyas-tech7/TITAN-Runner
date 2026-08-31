import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverGroqModels,
  discoverTogetherModels,
  discoverOpenRouterModels,
  discoverGeminiModels,
  discoverHuggingFaceModels,
} from '../src/providers/modelDiscovery.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('discoverGroqModels filters inactive and non-chat models, keeps the preferred model first', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/models');
    assert.equal(init.headers.authorization, 'Bearer test-key');
    return jsonResponse({
      data: [
        { id: 'whisper-large-v3', active: true },
        { id: 'llama-guard-3-8b', active: true },
        { id: 'llama-3.1-8b-instant', active: true },
        { id: 'deprecated-model', active: false },
        { id: 'llama-3.3-70b-versatile', active: true },
      ],
    });
  });

  const ids = await discoverGroqModels({
    apiKey: 'test-key',
    baseUrl: 'https://api.groq.com/openai/v1',
    preferredModel: 'llama-3.3-70b-versatile',
  });

  assert.deepEqual(ids, ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
});

test('discoverTogetherModels prefers -Free-suffixed / zero-priced entries over the full catalog', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse([
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', pricing: { input: 0.88, output: 0.88 } },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', pricing: { input: 0, output: 0 } },
    ]),
  );

  const ids = await discoverTogetherModels({ apiKey: 'k', baseUrl: 'https://api.together.xyz/v1' });
  assert.deepEqual(ids, ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free']);
});

test('discoverOpenRouterModels filters to pricing-zero / :free models only', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({
      data: [
        { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
        { id: 'openai/gpt-oss-20b:free', pricing: { prompt: '0', completion: '0' } },
      ],
    }),
  );

  const ids = await discoverOpenRouterModels({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' });
  assert.deepEqual(ids, ['openai/gpt-oss-20b:free']);
});

test('discoverGeminiModels strips the models/ prefix, keeps only generateContent-capable models, and ranks flash before pro', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers['x-goog-api-key'], 'k');
    return jsonResponse({
      models: [
        { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    });
  });

  const ids = await discoverGeminiModels({ apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  assert.deepEqual(ids, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('discoverHuggingFaceModels degrades to an empty list on a non-2xx response, never throwing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, false, 404));
  const ids = await discoverHuggingFaceModels({ apiKey: 'k', baseUrl: 'https://router.huggingface.co/v1' });
  assert.deepEqual(ids, []);
});

test('a network failure (fetch throws) is swallowed into an empty candidate list', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  });
  const ids = await discoverGroqModels({ apiKey: 'k', baseUrl: 'https://api.groq.com/openai/v1' });
  assert.deepEqual(ids, []);
});
