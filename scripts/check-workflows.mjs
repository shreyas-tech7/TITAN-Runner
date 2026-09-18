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
 *
 * Exit 1 with every violation listed, or 0 with a summary.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA_PIN = /^[0-9a-f]{40}$/;
const UNTRUSTED_EXPR = /\$\{\{\s*(github\.event\.|inputs\.|github\.head_ref|github\.event_path)/;

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

  let inRun = false;
  let runIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();

    if (inRun) {
      if (trimmed.length > 0 && indent <= runIndent) inRun = false;
      else {
        if (UNTRUSTED_EXPR.test(line)) violations.push(`${name}:${i + 1}: untrusted expression inside a run: script — pass it through env: instead`);
        if (/(curl|wget)[^\n|]*\|\s*(ba|z|k)?sh\b/.test(line)) violations.push(`${name}:${i + 1}: pipes a download into a shell`);
        continue;
      }
    }

    const runMatch = line.match(/^(\s*)(-\s+)?run:\s*(.*)$/);
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
