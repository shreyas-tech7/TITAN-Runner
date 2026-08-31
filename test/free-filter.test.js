import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreePriced } from '../src/providers/freeFilter.js';

test('an id ending :free or -free is free regardless of any other field', () => {
  assert.equal(isFreePriced({ id: 'deepseek/deepseek-chat-v3-0324:free' }), true);
  assert.equal(isFreePriced({ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free' }), true);
  assert.equal(isFreePriced({ id: 'openai/gpt-4o' }), false);
});

test('an explicit free:true flag wins outright', () => {
  assert.equal(isFreePriced({ id: 'anything', free: true }), true);
});

test('OpenRouter-shaped pricing.prompt/completion of "0" is free', () => {
  assert.equal(isFreePriced({ id: 'x', pricing: { prompt: '0', completion: '0' } }), true);
  assert.equal(isFreePriced({ id: 'x', pricing: { prompt: '0.0000002', completion: '0.0000002' } }), false);
});

test('Together/OpenCode-shaped pricing.input/output of 0 is free', () => {
  assert.equal(isFreePriced({ id: 'x', pricing: { input: 0, output: 0 } }), true);
  assert.equal(isFreePriced({ id: 'x', pricing: { input: 0.88, output: 0.88 } }), false);
});

test('a one-sided zero price (only prompt free, completion priced) is not free', () => {
  assert.equal(isFreePriced({ id: 'x', pricing: { prompt: '0', completion: '0.000001' } }), false);
});

test('an unrecognised or missing pricing shape is never assumed free', () => {
  assert.equal(isFreePriced({ id: 'x' }), false);
  assert.equal(isFreePriced({ id: 'x', pricing: {} }), false);
  assert.equal(isFreePriced({ id: 'x', pricing: { tier: 'premium' } }), false);
  assert.equal(isFreePriced(null), false);
  assert.equal(isFreePriced(undefined), false);
  assert.equal(isFreePriced('not-an-object'), false);
});
