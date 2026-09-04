import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase2Agent } from '../src/agents/phase2Agent.js';

/** A fake registry that records the exact messages/service it was handed. */
function captureRegistry() {
  const calls = [];
  return {
    calls,
    async chat(messages, opts) {
      calls.push({ messages, opts });
      return { text: 'ok', service: 'groq', tokensUsed: 1 };
    },
  };
}

test('Phase2Agent sends the shared envelope instruction (regression: the local prompt builder dropped it)', async () => {
  const fake = captureRegistry();
  const agent = new Phase2Agent({ registry: fake });

  await agent.execute(
    { id: 't1', title: 'Build X', aspect: 'code-generation', description: 'do the thing', deliverable: 'a file' },
    'shared context here',
    {},
  );

  assert.equal(fake.calls.length, 1);
  const content = fake.calls[0].messages[0].content;
  // The deliverable prompt is the shared AgentAdapter one: it must instruct
  // the model to emit the fenced JSON envelope, and carry the shared context.
  assert.match(content, /"files"/);
  assert.match(content, /fenced JSON code block/);
  assert.match(content, /shared context here/);
  assert.match(content, /Build X/);
});

test('Phase2Agent still strips the pool prefix when a phase2:* model id is passed', async () => {
  const fake = captureRegistry();
  const agent = new Phase2Agent({ registry: fake });

  await agent.execute(
    { id: 't1', title: 'X', aspect: 'testing', description: 'd', deliverable: 'd' },
    '',
    { modelId: 'phase2:gemini' },
  );

  assert.equal(fake.calls[0].opts.service, 'gemini');
});
