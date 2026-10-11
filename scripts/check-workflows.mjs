#!/usr/bin/env node
/**
 * Static checks over `.github/workflows/*.yml`, run in CI and by
 * `test/workflows.test.js`. No YAML dependency: the checks are line-shaped
 * and deliberately conservative (a false positive costs a review comment; a
 * false negative costs the repo's secrets).
 *
 *   1. Every `uses:` is pinned to a full 40-hex commit SHA.
 *   2. No `${{ github.event.* }}`, `${{ inputs.* }}`, or
 *      `${{ github.head_ref }}` expression appears inside a `run:` script —
 *      untrusted text reaches a shell only through `env:` and quoting.
 *   3. No `pull_request_target` trigger (it runs with secrets on fork code).
 *   4. Every workflow declares top-level `permissions:`.
 *   5. No `curl … | sh`-style pipes into a shell.
 *   6. (RT2) No trigger that a stranger can fire: issues, comments, discussions, forks, and the like. The only
 *      outsider trigger that stays is `pull_request`, and a workflow that has it holds no secret except GITHUB_TOKEN.
 *   7. (RT2) Least privilege: the top-level `permissions:` block grants no write permission. A job that needs write
 *      access lists it in its own `permissions:` block. `write-all` never appears.
 *   8. (RT2) Untrusted text never reaches a script: the branch name and the ref count too, and so does the `script:`
 *      input of an action that runs JavaScript.
 *   9. (RT2) A workflow that commits to state/ joins the shared concurrency group `titan-state`.
 *  10. (RT3) A workflow never runs `git push`, `git commit`, `gh issue`, `gh pr`, or `gh api` with a write method.
 *      Writes go through scripts that use the Reviewer Gate. `actions/github-script` is not allowed for the same reason.
 *  11. (RT2) A step that makes a secret at run time masks it with `::add-mask::`.
 *
 * Exit 1 with every violation listed, or 0 with a summary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA_PIN = /^[0-9a-f]{40}$/;
const UNTRUSTED_EXPR = /\$\{\{\s*(github\.event\.|inputs\.|github\.head_ref|github\.base_ref|github\.ref_name|github\.ref\b|github\.event_path)/;

/** Triggers that a stranger can fire on a public repository. */
export const OUTSIDER_TRIGGERS = Object.freeze([
  'issues', 'issue_comment', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment', 'discussion',
  'discussion_comment', 'fork', 'watch', 'gollum', 'label', 'milestone', 'project', 'project_card', 'project_column', 'public',
  'registry_package', 'workflow_run',
]);

/** A run block that makes a secret must mask it. */
const MAKES_SECRET = /randomBytes\(|openssl\s+rand|ssh-keygen|generateKey\(/;

/**
 * @param {string} text
 * @param {string} name
 * @returns {string[]} violations
 */
export function checkWorkflowText(text, name) {
  const violations = [];
  const lines = text.split('\n');
  if (!/^permissions:/m.test(text)) violations.push(`${name}: no top-level permissions: block`);
  if (/^\s*pull_request_target\s*:/m.test(text) || /^on:\s*\[.*pull_request_target/m.test(text)) {
    violations.push(`${name}: uses pull_request_target`);
  }

  // (6) outsider triggers
  const onStart = lines.findIndex((l) => /^on:/.test(l));
  const triggerLines = [];
  for (let k = onStart + 1; onStart >= 0 && k < lines.length && (lines[k].trim() === '' || /^\s/.test(lines[k])); k += 1) triggerLines.push(lines[k]);
  const triggers = new Set(triggerLines.map((l) => l.match(/^ {2}([a-z_]+):/)?.[1]).filter(Boolean));
  for (const m of text.matchAll(/^on:\s*\[([^\]]*)\]/gm)) for (const t of m[1].split(',')) triggers.add(t.trim());
  const single = text.match(/^on:\s*([a-z_]+)\s*$/m);
  if (single) triggers.add(single[1]);
  for (const t of triggers) if (OUTSIDER_TRIGGERS.includes(t)) violations.push(`${name}: the trigger "${t}" can be fired by a stranger. Do not use it`);
  if (triggers.has('pull_request') || triggers.has('push')) {
    for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (m[1] !== 'GITHUB_TOKEN' && triggers.has('pull_request')) violations.push(`${name}: a pull_request workflow reads the secret ${m[1]}. A fork pull request must reach no secret`);
    }
  }

  // (7) least privilege
  const topPerms = (text.match(/^permissions:[ \t]*(.*)$((?:\n[ \t]+.*)*)/m) ?? []);
  const topText = `${topPerms[1] ?? ''}\n${topPerms[2] ?? ''}`;
  if (/write-all/.test(text)) violations.push(`${name}: uses permissions: write-all`);
  for (const m of topText.matchAll(/([a-z-]+):\s*write/g)) violations.push(`${name}: the top-level permissions grant "${m[1]}: write". Move it to the job that needs it`);

  // (9) the shared state group
  const commitsState = /publish-state\.mjs/.test(text) || /\bgit\s+(push|commit)\b/.test(text);
  if (commitsState && !/titan-state/.test(text)) violations.push(`${name}: commits to state/ but does not join the concurrency group titan-state`);

  // (10) every write goes through the gate
  if (/^\s*-?\s*(run|script):[\s\S]*?\bgit\s+(push|commit)\b/m.test(text) && /\bgit\s+(push|commit)\b/.test(text.replace(/^\s*#.*$/gm, ''))) violations.push(`${name}: runs git push or git commit. Use scripts/publish-state.mjs`);
  if (/\bgh\s+(issue|pr|release|repo)\s+(create|comment|close|edit|merge|delete)\b|\bgh\s+api\b[^\n]*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/.test(text.replace(/^\s*#.*$/gm, ''))) violations.push(`${name}: writes to GitHub with the gh tool. Use a script that goes through the Reviewer Gate`);
  if (/uses:\s*actions\/github-script/.test(text)) violations.push(`${name}: uses actions/github-script. Writes to GitHub go through the Reviewer Gate (scripts/alert-issue.mjs)`);

  let inRun = false;
  let runIndent = -1;
  let runBody = [];
  const flushRun = () => {
    const body = runBody.join('\n');
    if (MAKES_SECRET.test(body) && !/::add-mask::/.test(body)) violations.push(`${name}: a step makes a secret at run time and does not mask it with ::add-mask::`);
    runBody = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();

    if (inRun) {
      if (trimmed.length > 0 && indent <= runIndent) {
        inRun = false;
        flushRun();
      } else {
        runBody.push(line);
        if (UNTRUSTED_EXPR.test(line)) violations.push(`${name}:${i + 1}: untrusted expression inside a run: script — pass it through env: instead`);
        if (/(curl|wget)[^\n|]*\|\s*(ba|z|k)?sh\b/.test(line)) violations.push(`${name}:${i + 1}: pipes a download into a shell`);
        continue;
      }
    }

    const runMatch = line.match(/^(\s*)(-\s+)?(?:run|script):\s*(.*)$/);
    if (runMatch) {
      const inline = runMatch[3].trim();
      if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
        inRun = true;
        runIndent = runMatch[1].length + (runMatch[2] ? runMatch[2].length : 0);
      } else if (UNTRUSTED_EXPR.test(inline)) {
        violations.push(`${name}:${i + 1}: untrusted expression inside a run: script — pass it through env: instead`);
      }
      continue;
    }

    const usesMatch = line.match(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/);
    if (usesMatch) {
      const ref = usesMatch[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      const at = ref.lastIndexOf('@');
      const pin = at === -1 ? '' : ref.slice(at + 1);
      if (!SHA_PIN.test(pin)) violations.push(`${name}:${i + 1}: "${ref}" is not pinned to a full commit SHA`);
    }
  }
  if (inRun) flushRun();
  return violations;
}

/** @param {string} dir @returns {{ files: number, violations: string[] }} */
export function checkWorkflowsDir(dir) {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const violations = [];
  for (const f of files) violations.push(...checkWorkflowText(readFileSync(join(dir, f), 'utf8'), f));
  return { files: files.length, violations };
}

const invokedDirectly = process.argv[1] && /check-workflows\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const dir = process.argv[2] ?? join(process.cwd(), '.github', 'workflows');
  const { files, violations } = checkWorkflowsDir(dir);
  if (violations.length > 0) {
    console.error('Workflow check failed:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`check-workflows: ${files} workflow(s) clean.`);
}
