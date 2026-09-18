import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRepoRelativePath } from '../src/lib/pathJail.js';
import { findUnwritablePaths } from '../src/selfImprove.js';
import { isDenylisted } from '../src/denylist.js';

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'titan-jail-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

test('ordinary repo-relative paths are accepted and resolved inside the root', () => {
  const root = scratchRepo();
  try {
    for (const p of ['src/new.js', 'docs/a/b/c.md', 'README.md', '-dashed-name.txt', 'src\\win\\style.js']) {
      const r = checkRepoRelativePath(root, p);
      assert.equal(r.ok, true, p);
      assert.ok(r.absolute.startsWith(root), p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.git and .github at any depth, node_modules, and CI-controlling root files are rejected before any write', () => {
  const root = scratchRepo();
  try {
    const rejected = [
      '.git/hooks/post-checkout', '.git/config', 'sub/.git/hooks/pre-commit', '.GIT/HEAD',
      '.github/workflows/x.yml', '.github/ISSUE_TEMPLATE/evil.yml',
      'node_modules/left-pad/index.js',
      'package.json', 'package-lock.json', '.npmrc', 'Package.JSON', '.gitmodules',
      '.env', '.env.local', 'config/secrets.pem', 'id_rsa', 'x/credentials.json',
    ];
    for (const p of rejected) {
      assert.equal(checkRepoRelativePath(root, p).ok, false, p);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('traversal, absolute, drive-letter, empty, control-character, and over-long paths are rejected', () => {
  const root = scratchRepo();
  try {
    const rejected = ['../etc/passwd', 'src/../../x', '/etc/passwd', 'C:\\Windows\\x', '', '.', 'src/./a', 'a\u0000b', 'x\nrm -rf', `${'a/'.repeat(200)}b`];
    for (const p of rejected) assert.equal(checkRepoRelativePath(root, p).ok, false, JSON.stringify(p));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked ancestor or a symlinked target escapes the jail and is rejected', () => {
  const root = scratchRepo();
  const outside = mkdtempSync(join(tmpdir(), 'titan-outside-'));
  try {
    symlinkSync(outside, join(root, 'linked'));
    writeFileSync(join(outside, 'real.txt'), 'x');
    symlinkSync(join(outside, 'real.txt'), join(root, 'src', 'link.txt'));
    assert.equal(checkRepoRelativePath(root, 'linked/anything.txt').ok, false);
    assert.equal(checkRepoRelativePath(root, 'src/link.txt').ok, false);
    assert.equal(checkRepoRelativePath(root, 'src/fresh.txt').ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('selfImprove.findUnwritablePaths lists every rejected proposal with its reason and none of the good ones', () => {
  const root = scratchRepo();
  try {
    const out = findUnwritablePaths([{ path: 'src/ok.js' }, { path: '.git/hooks/post-checkout' }, { path: '../up.js' }], root);
    assert.equal(out.length, 2);
    assert.match(out[0], /\.git\/hooks\/post-checkout: /);
    assert.match(out[1], /\.\.\/up\.js: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the denylist covers the same protected trees so the CI backstop agrees with the jail', () => {
  for (const p of ['.git/hooks/x', '.github/ISSUE_TEMPLATE/x.yml', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'src/security/authorization.js', 'src/lib/pathJail.js']) {
    assert.equal(isDenylisted(p), true, p);
  }
  assert.equal(isDenylisted('src/pulse.js'), false);
});
