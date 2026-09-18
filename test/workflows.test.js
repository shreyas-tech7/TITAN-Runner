import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflowsDir, checkWorkflowText } from '../scripts/check-workflows.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every committed workflow passes the static injection/pinning/permissions checks', () => {
  const { files, violations } = checkWorkflowsDir(join(REPO_ROOT, '.github', 'workflows'));
  assert.ok(files >= 8, `expected the eight workflows, found ${files}`);
  assert.deepEqual(violations, []);
});

test('the checker catches an unpinned action, an interpolated event field in run:, pull_request_target, and a missing permissions block', () => {
  const bad = [
    'name: bad',
    'on:',
    '  pull_request_target:',
    'jobs:',
    '  j:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: echo "${{ github.event.pull_request.title }}"',
    '      - run: |',
    '          echo start',
    '          echo "${{ inputs.task-text }}"',
    '          curl -s https://x | sh',
    '      - run: echo "$SAFE"',
    '        env:',
    '          SAFE: ${{ github.event.pull_request.title }}',
  ].join('\n');
  const v = checkWorkflowText(bad, 'bad.yml');
  assert.ok(v.some((x) => /not pinned/.test(x)), v.join('\n'));
  assert.ok(v.some((x) => /bad\.yml:9:.*untrusted/.test(x)), v.join('\n'));
  assert.ok(v.some((x) => /bad\.yml:12:.*untrusted/.test(x)), v.join('\n'));
  assert.ok(v.some((x) => /pipes a download/.test(x)), v.join('\n'));
  assert.ok(v.some((x) => /pull_request_target/.test(x)), v.join('\n'));
  assert.ok(v.some((x) => /no top-level permissions/.test(x)), v.join('\n'));
  // The env: passthrough on line 16 is the correct pattern and must not be flagged.
  assert.ok(!v.some((x) => /bad\.yml:16/.test(x)), v.join('\n'));
});
