/**
 * @file Builds the provider secret blocks that appear in the workflows and in `.env.example` (Wave 12, K1).
 *
 * The catalog is the source of truth. `scripts/sync-provider-env.mjs` writes these blocks. The gate
 * `scripts/check-provider-catalog.mjs` compares them with the files, so a hand edit that drifts fails CI.
 */
import { readFileSync } from 'node:fs';

export const WORKFLOWS_WITH_PROVIDER_ENV = ['titan-pulse.yml', 'spawn-subagent.yml', 'provider-selftest.yml', 'vm-agent.yml'];
export const BEGIN = '# BEGIN provider secrets (generated from config/providers.catalog.json, run npm run sync:providers)';
export const END = '# END provider secrets';

export function readCatalog(root) {
  return JSON.parse(readFileSync(`${root}/config/providers.catalog.json`, 'utf8'));
}

/** The env map lines for one workflow step, at the given indent. */
export function workflowEnvBlock(catalog, indent) {
  const pad = ' '.repeat(indent);
  const lines = [`${pad}${BEGIN}`];
  for (const p of catalog.providers) {
    for (const name of Object.values(p.secrets)) lines.push(`${pad}${name}: \${{ secrets.${name} }}`);
  }
  lines.push(`${pad}${END}`);
  return lines.join('\n');
}

/** The `.env.example` block. Every value is empty. */
export function envExampleBlock(catalog) {
  const lines = [BEGIN, '#'];
  for (const p of catalog.providers) {
    lines.push(`# ${p.label} (${p.id})${p.getKeyUrl ? `. Get a key at ${p.getKeyUrl}` : ''}`);
    if (p.envNote) lines.push(`# ${p.envNote}`);
    for (const name of Object.values(p.secrets)) lines.push(`${name}=`);
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * Replace the text between every pair of markers, or return null when no marker is found.
 * @param {string} text
 * @param {(indent: number) => string} makeBlock
 */
export function replaceBlock(text, makeBlock) {
  const lines = text.split('\n');
  const out = [];
  let found = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== BEGIN) {
      out.push(lines[i]);
      continue;
    }
    const end = lines.findIndex((l, j) => j > i && l.trim() === END);
    if (end === -1) return null;
    out.push(makeBlock(lines[i].match(/^(\s*)/)[1].length));
    i = end;
    found += 1;
  }
  return found === 0 ? null : out.join('\n');
}
