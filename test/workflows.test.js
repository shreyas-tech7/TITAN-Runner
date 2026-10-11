import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { OUTSIDER_TRIGGERS, checkWorkflowsDir, checkWorkflowText } from '../scripts/check-workflows.mjs';

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

const wf = (lines) => lines.join('\n');
const PIN = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

test('RT2: a trigger that a stranger can fire is refused, and the list holds the known ones', () => {
  for (const trigger of ['issues', 'issue_comment', 'pull_request_target', 'discussion', 'fork', 'workflow_run', 'pull_request_review_comment']) {
    const v = checkWorkflowText(wf(['name: x', 'on:', `  ${trigger}:`, '    types: [opened]', 'permissions:', '  contents: read', 'jobs: {}']), 'x.yml');
    assert.ok(v.some((m) => new RegExp(`trigger "${trigger}"`).test(m)), `${trigger}: ${v.join('|')}`);
  }
  const inline = checkWorkflowText(wf(['name: x', 'on: [push, issues]', 'permissions:', '  contents: read', 'jobs: {}']), 'x.yml');
  assert.ok(inline.some((m) => /trigger "issues"/.test(m)));
  const fine = checkWorkflowText(wf(['name: x', 'on:', '  schedule:', '    - cron: "0 0 * * *"', '  workflow_dispatch: {}', '  repository_dispatch:', '    types: [a]', 'permissions:', '  contents: read', 'jobs: {}']), 'x.yml');
  assert.deepEqual(fine, []);
  assert.ok(OUTSIDER_TRIGGERS.includes('issue_comment'));
});

test('RT2: a pull_request workflow may not read a secret other than GITHUB_TOKEN', () => {
  const bad = checkWorkflowText(wf(['name: x', 'on:', '  pull_request:', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', `      - uses: ${PIN}`, '      - run: echo hi', '        env:', '          K: ${{ secrets.GROQ_API_KEY }}']), 'x.yml');
  assert.ok(bad.some((m) => /pull_request workflow reads the secret GROQ_API_KEY/.test(m)), bad.join('|'));
  const ok = checkWorkflowText(wf(['name: x', 'on:', '  pull_request:', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', `      - uses: ${PIN}`, '      - run: echo hi', '        env:', '          T: ${{ secrets.GITHUB_TOKEN }}']), 'x.yml');
  assert.deepEqual(ok, []);
});

test('RT2: the top-level permissions grant no write access, and write-all never appears', () => {
  const top = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: write', '  issues: read', 'jobs: {}']), 'x.yml');
  assert.ok(top.some((m) => /top-level permissions grant "contents: write"/.test(m)), top.join('|'));
  const all = checkWorkflowText(wf(['name: x', 'on: push', 'permissions: write-all', 'jobs: {}']), 'x.yml');
  assert.ok(all.some((m) => /write-all/.test(m)));
  const job = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    permissions:', '      contents: write', '    steps: []']), 'x.yml');
  assert.deepEqual(job, [], 'a job may ask for write access in its own block');
});

test('RT2: the branch name and the ref count as untrusted text, in run: and in script:', () => {
  for (const expr of ['github.ref_name', 'github.head_ref', 'github.base_ref', 'github.ref', 'github.event.pull_request.title', 'inputs.x']) {
    const v = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', `      - run: echo "\${{ ${expr} }}"`]), 'x.yml');
    assert.ok(v.some((m) => /untrusted expression/.test(m)), `${expr}: ${v.join('|')}`);
  }
  const script = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - uses: someone/act@3d3c42e5aac5ba805825da76410c181273ba90b1', '        with:', '          script: |', '            console.log("\${{ github.event.issue.title }}")']), 'x.yml');
  assert.ok(script.some((m) => /untrusted expression/.test(m)), script.join('|'));
  const viaEnv = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - run: echo "$B"', '        env:', '          B: ${{ github.ref_name }}']), 'x.yml');
  assert.deepEqual(viaEnv, [], 'env is the safe way');
});

test('RT2: a workflow that commits to state/ must join the group titan-state', () => {
  const without = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - run: node scripts/publish-state.mjs --message x']), 'x.yml');
  assert.ok(without.some((m) => /titan-state/.test(m)), without.join('|'));
  const withGroup = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'concurrency:', '  group: titan-state', 'jobs:', '  j:', '    steps:', '      - run: node scripts/publish-state.mjs --message x']), 'x.yml');
  assert.deepEqual(withGroup, []);
  const expression = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'concurrency:', "  group: ${{ cond && 'single' || 'titan-state' }}", 'jobs:', '  j:', '    steps:', '      - run: node scripts/publish-state.mjs --message x']), 'x.yml');
  assert.deepEqual(expression, []);
});

test('RT3: a workflow never writes to GitHub by itself', () => {
  const cases = ['git push', 'git commit -m x', 'gh issue create --title x', 'gh pr merge 3', 'gh api -X POST /repos/a/b/issues', 'gh api repos/a/b --method DELETE'];
  for (const cmd of cases) {
    const v = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'concurrency:', '  group: titan-state', 'jobs:', '  j:', '    steps:', `      - run: ${cmd}`]), 'x.yml');
    assert.ok(v.length > 0, `${cmd} must be flagged`);
  }
  const action = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b']), 'x.yml');
  assert.ok(action.some((m) => /github-script/.test(m)));
  const read = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - run: gh api repos/a/b/issues']), 'x.yml');
  assert.deepEqual(read, [], 'a read is fine');
});

test('RT2: a step that makes a secret at run time must mask it', () => {
  const bad = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - run: |', '          node -e "process.stdout.write(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))" > key', '          wrangler secret put K < key']), 'x.yml');
  assert.ok(bad.some((m) => /::add-mask::/.test(m)), bad.join('|'));
  const ok = checkWorkflowText(wf(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  j:', '    steps:', '      - run: |', '          node -e "process.stdout.write(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))" > key', '          echo "::add-mask::$(cat key)"', '          wrangler secret put K < key']), 'x.yml');
  assert.deepEqual(ok, []);
});

test('RT2: every committed workflow that commits state joins titan-state, and none runs git push', () => {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  const committers = [];
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/^\s*(?:-\s+)?run:[\s\S]*?\bgit\s+(push|commit)\b/m.test(text.replace(/^\s*#.*$/gm, '')), `${f} runs git push or git commit`);
    if (/publish-state\.mjs/.test(text)) committers.push(f);
  }
  assert.deepEqual(committers.sort(), ['keepalive.yml', 'ops-canary.yml', 'provider-selftest.yml', 'state-maintenance.yml', 'titan-control.yml', 'titan-pulse.yml']);
  for (const f of committers) assert.match(readFileSync(join(dir, f), 'utf8'), /titan-state/, f);
});

test('RT2: the only workflow with the OIDC permission is the Pages deploy, and the other triggers are safe', () => {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (f !== 'pages-deploy.yml') assert.ok(!/id-token:\s*write/.test(text), f);
    for (const t of OUTSIDER_TRIGGERS) assert.ok(!new RegExp(`^\\s{2}${t}:`, 'm').test(text.split(/^jobs:/m)[0]), `${f} has the trigger ${t}`);
  }
});

test('RT6: the VM workflow holds the Reviewer Gate key and no other provider key', () => {
  const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'vm-agent.yml'), 'utf8');
  const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(secrets)], ['GROQ_API_KEY', 'GROQ_MODEL', 'TITAN_ADMIN_TOKEN', 'TITAN_CALLBACK_TOKEN']);
});
