#!/usr/bin/env node
/**
 * @file Documentation check for ASD-STE100 Simplified Technical English (Wave 12, D2).
 *
 * The check reads Markdown. It looks at prose only. It skips fenced code, inline code, URLs, tables,
 * quotes, headings (except for the dash and semicolon rules), HTML comments, and front matter.
 *
 * Hard rules (a changed line that breaks one fails the run):
 *   - no em dash in prose
 *   - no semicolon in prose
 *
 * Soft rules (a sentence that breaks one does not pass the score):
 *   - a step (a numbered list item) has more than 20 words
 *   - any other sentence has more than 25 words
 *   - an "-ing" verb form
 *   - a contraction
 *   - passive voice
 *   - an en dash
 *
 * The score is the share of changed prose sentences that pass every rule. A score below the minimum
 * (80 by default) fails the run. Text that did not change gives warnings only.
 *
 * Usage:
 *   node scripts/check-ste.mjs --base origin/main     lines that changed against a base
 *   node scripts/check-ste.mjs --staged               lines that are staged
 *   node scripts/check-ste.mjs --all                  every line counts as changed
 *   node scripts/check-ste.mjs [--min 80] [--quiet] [file.md ...]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const MAX_STEP_WORDS = 20;
export const MAX_DESCRIPTION_WORDS = 25;
export const DEFAULT_MIN_SCORE = 80;

/** Files that hold text which must stay as it is, such as the verbatim brief. */
const IGNORED_FILES = [
  /^docs\/waves\/WAVE12_BRIEF\.md$/,
  /^state\//,
  /^dashboard\/node_modules\//,
  /^worker\/node_modules\//,
  /^node_modules\//,
  /^docs\/screenshots\//,
  /^LICENSE/,
];

/** "-ing" words that are nouns or part of a technical name. Not a verb form. */
const ING_ALLOW = new Set([
  'string', 'strings', 'thing', 'things', 'something', 'nothing', 'anything', 'everything', 'during', 'morning',
  'evening', 'ceiling', 'heading', 'headings', 'padding', 'mapping', 'mappings', 'pending', 'building', 'setting',
  'settings', 'warning', 'warnings', 'bring', 'ring', 'spring', 'king', 'sibling', 'siblings', 'ping', 'pinging',
  'listing', 'timing', 'routing', 'logging', 'caching', 'binding', 'bindings', 'sealing', 'meeting', 'meetings',
  'ordering', 'wording', 'training', 'testing', 'hosting', 'tracking', 'billing', 'branding', 'casing', 'pricing',
  'scheduling', 'staging', 'tooling', 'encoding', 'decoding', 'parsing', 'matching', 'linting', 'bundling',
  'rendering', 'monitoring', 'reporting', 'rating', 'warning:', 'spelling', 'beginning', 'ending', 'feeling',
]);

const CONTRACTION = /\b(?:\w+n't|\w+'(?:re|ve|ll|d|m)|(?:it|that|there|here|what|let|he|she|who|where|how)'s)\b/i;
const PASSIVE = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ed|made|done|sent|given|shown|kept|written|read|set|seen|taken|known|found|run|built|put|held|left|chosen|stored|sealed)\b/i;

/**
 * @param {string} text
 * @returns {string[]} Sentences of one paragraph.
 */
export function splitSentences(text) {
  const out = [];
  let current = '';
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"(\[])/);
  for (const part of parts) {
    current = part.trim();
    if (current) out.push(current);
  }
  return out;
}

/** Remove inline code, links, URLs, and emphasis marks. Code becomes the word "X" so word counts stay fair. */
export function stripInline(text) {
  return text
    .replace(/`[^`]*`/g, 'X')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)]*[^\s).,;:!?]/g, 'URL')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a Markdown file into prose blocks. A block is one paragraph, one list item, or one heading.
 * @param {string} text
 * @returns {Array<{ kind: 'paragraph'|'step'|'item'|'heading', lines: number[], text: string }>}
 */
export function proseBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let inFence = false;
  let inFront = false;
  let inComment = false;
  let current = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    const no = i + 1;
    if (i === 0 && line === '---') {
      inFront = true;
      continue;
    }
    if (inFront) {
      if (line === '---') inFront = false;
      continue;
    }
    if (/^(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('|') || line.startsWith('>') || /^[-*_]{3,}$/.test(line) || /^\s{4,}\S/.test(raw) && !current) {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', lines: [no], text: heading[1] });
      continue;
    }
    const step = line.match(/^\d+[.)]\s+(.*)$/);
    const item = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (step || item) {
      flush();
      current = { kind: step ? 'step' : 'item', lines: [no], text: (step ?? item)[1] };
      continue;
    }
    if (current) {
      current.lines.push(no);
      current.text += ` ${line}`;
    } else {
      current = { kind: 'paragraph', lines: [no], text: line };
    }
  }
  flush();
  return blocks;
}

/**
 * Check the rules on one sentence.
 * @param {string} sentence Already stripped of inline code and links.
 * @param {'paragraph'|'step'|'item'|'heading'} kind
 * @returns {{ hard: string[], soft: string[] }}
 */
export function checkSentence(sentence, kind) {
  const hard = [];
  const soft = [];
  if (sentence.includes('—')) hard.push('em dash');
  if (sentence.includes(';')) hard.push('semicolon');
  if (kind === 'heading') return { hard, soft };
  if (sentence.includes('–')) soft.push('en dash');
  const words = sentence.split(/\s+/).filter(Boolean);
  const limit = kind === 'step' ? MAX_STEP_WORDS : MAX_DESCRIPTION_WORDS;
  if (words.length > limit) soft.push(`${words.length} words (limit ${limit})`);
  const ing = words
    .map((w) => w.replace(/[^A-Za-z']/g, '').toLowerCase())
    .filter((w, i) => w.length > 4 && w.endsWith('ing') && !ING_ALLOW.has(w));
  if (ing.length > 0) soft.push(`"-ing" form: ${[...new Set(ing)].slice(0, 3).join(', ')}`);
  if (CONTRACTION.test(sentence)) soft.push('contraction');
  if (PASSIVE.test(sentence)) soft.push('passive voice');
  return { hard, soft };
}

/**
 * @param {string} text Markdown source.
 * @param {{ changed?: Set<number>|null }} [opts] `null` means every line counts as changed.
 * @returns {{ scored: number, passed: number, failures: Array<{line:number,message:string,sentence:string}>, warnings: Array<{line:number,message:string,sentence:string}> }}
 */
export function analyzeMarkdown(text, opts = {}) {
  const changed = opts.changed === undefined ? null : opts.changed;
  const result = { scored: 0, passed: 0, failures: [], warnings: [] };
  for (const block of proseBlocks(text)) {
    const isChanged = changed === null || block.lines.some((n) => changed.has(n));
    const clean = stripInline(block.text);
    if (!clean) continue;
    const sentences = block.kind === 'heading' ? [clean] : splitSentences(clean);
    for (const sentence of sentences) {
      const { hard, soft } = checkSentence(sentence, block.kind);
      const line = block.lines[0];
      const short = sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
      if (isChanged) {
        for (const h of hard) result.failures.push({ line, message: h, sentence: short });
        for (const s of soft) result.warnings.push({ line, message: s, sentence: short });
        if (block.kind !== 'heading') {
          result.scored += 1;
          if (hard.length === 0 && soft.length === 0) result.passed += 1;
        }
      } else {
        for (const m of [...hard, ...soft]) result.warnings.push({ line, message: `${m} (old text)`, sentence: short });
      }
    }
  }
  return result;
}

/** @param {string} diffText Output of `git diff -U0`. @returns {Map<string, Set<number>>} */
export function changedLinesFromDiff(diffText) {
  const map = new Map();
  let file = null;
  let next = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (!map.has(file)) map.set(file, new Set());
      map.get(file).add(next);
      next += 1;
    }
  }
  return map;
}

function isIgnored(path) {
  return IGNORED_FILES.some((re) => re.test(path));
}

function walkMarkdown(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.next' || name === 'out') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkMarkdown(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = { base: null, staged: false, all: false, min: DEFAULT_MIN_SCORE, quiet: false, files: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--base') opt.base = args[++i];
    else if (a === '--staged') opt.staged = true;
    else if (a === '--all') opt.all = true;
    else if (a === '--min') opt.min = Number(args[++i]);
    else if (a === '--quiet') opt.quiet = true;
    else opt.files.push(a);
  }

  /** @type {Map<string, Set<number>|null>} */
  const targets = new Map();
  if (opt.files.length > 0) {
    for (const f of opt.files) targets.set(f, null);
  } else if (opt.all) {
    for (const f of walkMarkdown(process.cwd())) targets.set(relative(process.cwd(), f), null);
  } else if (opt.base || opt.staged) {
    const gitArgs = opt.staged ? ['diff', '--cached', '-U0', '--no-color', '--', '*.md'] : ['diff', '-U0', '--no-color', `${opt.base}...HEAD`, '--', '*.md'];
    let diff = '';
    try {
      diff = execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      console.error(`check-ste: cannot compute the diff: ${err.message}`);
      process.exit(2);
    }
    for (const [file, lines] of changedLinesFromDiff(diff)) targets.set(file, lines);
  } else {
    console.error('check-ste: give --base <ref>, --staged, --all, or a file list.');
    process.exit(2);
  }

  let scored = 0;
  let passed = 0;
  let failures = 0;
  let warnings = 0;
  for (const [file, changed] of targets) {
    if (isIgnored(file) || !file.endsWith('.md')) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // a deleted file
    }
    const r = analyzeMarkdown(text, { changed });
    scored += r.scored;
    passed += r.passed;
    failures += r.failures.length;
    warnings += r.warnings.length;
    for (const f of r.failures) console.error(`FAIL ${file}:${f.line}: ${f.message}: ${f.sentence}`);
    if (!opt.quiet) for (const w of r.warnings) console.log(`warn ${file}:${w.line}: ${w.message}: ${w.sentence}`);
  }
  const score = scored === 0 ? 100 : Math.round((passed / scored) * 1000) / 10;
  console.log(`check-ste: ${scored} prose sentence(s) scored, ${passed} passed, score ${score}%, ${failures} hard failure(s), ${warnings} warning(s).`);
  if (failures > 0) {
    console.error('check-ste: an em dash or a semicolon is in prose. Remove it.');
    process.exit(1);
  }
  if (score < opt.min) {
    console.error(`check-ste: the score ${score}% is below the minimum ${opt.min}%.`);
    process.exit(1);
  }
}

if (process.argv[1] && /check-ste\.mjs$/.test(process.argv[1])) main(process.argv);
