import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDenylisted, findDenylistViolations } from '../src/denylist.js';

test('protected directories and files are denylisted', () => {
  assert.equal(isDenylisted('.github/workflows/ci.yml'), true);
  assert.equal(isDenylisted('src/reviewer/policy.js'), true);
  assert.equal(isDenylisted('src/denylist.js'), true);
  assert.equal(isDenylisted('src/lib/redact.js'), true);
});

test('ordinary source files are not denylisted', () => {
  assert.equal(isDenylisted('src/pulse.js'), false);
  assert.equal(isDenylisted('dashboard/app/page.tsx'), false);
});

test('findDenylistViolations returns exactly the offending subset', () => {
  const changed = ['src/pulse.js', '.github/workflows/titan-pulse.yml', 'README.md'];
  assert.deepEqual(findDenylistViolations(changed), ['.github/workflows/titan-pulse.yml']);
});
