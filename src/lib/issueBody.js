/**
 * @file Cleans up the title and body of a `titan-task` issue before intake
 * reads it, so an issue created by an automation tool (a Zapier "Create
 * Issue" action, a Make.com "Create an Issue" module) is understood as well
 * as one typed by hand. Runs BEFORE `parseTaskYaml`, and is strictly
 * additive: a hand-typed or dashboard-filed body comes out with the same
 * content it went in with (only line endings, invisible characters and
 * runaway blank lines are tidied).
 *
 * Two tiers, deliberately different in how far they are trusted:
 *
 *   1. MARKERS (robust; what the docs tell you to use). The automation's
 *      body template wraps the task in
 *          <!-- titan-intake:begin --> … <!-- titan-intake:end -->
 *      and everything outside the markers — whatever header, footer or
 *      signature the tool adds — is dropped. GitHub does not render HTML
 *      comments, so the markers are invisible on the issue page. A
 *      `<!-- titan-task-v1 … -->` block inside the markers still works.
 *
 *   2. BANNERS (best effort, for bodies without markers). An automation
 *      banner on the very first or very last line — "Sent via Zapier",
 *      "This issue was created by a Zap", "Powered by Make.com" — is removed
 *      together with its separator, and so are adjacent Zap/scenario
 *      metadata lines, but only when they sit in a block with at least one
 *      banner line. The patterns are anchored and short on purpose: prose
 *      that merely mentions Zapier ("Sent via Zapier last week, the email…"),
 *      or a task that starts "Scenario: a user logs in", is never touched.
 *
 * No HTML handling: map the plain-text body field in the automation. A
 * developer's task can legitimately contain `<div>`, so tags are left alone.
 *
 * Nothing here is an authorization decision. An automation-created issue is
 * authored by the GitHub account connected to the automation, and intake
 * still checks that account (`security/authorization.js`) exactly as it
 * does for a human.
 */

const BEGIN_MARKER = '<!-- titan-intake:begin -->';
const END_MARKER = '<!-- titan-intake:end -->';
const MARKER_PATTERN = /<!--\s*titan-intake:(begin|end)\s*-->/gi;

// `(?![a-z0-9])` rather than `\\b`: `_` is a word character, and a banner is
// often wrapped in Markdown italics ("_Sent via Zapier_").
const BRAND = '(?:zapier|zap|make(?:\\.com)?|integromat)(?![a-z0-9])';
// After the brand only the end of the line, or a punctuation-led tail, may follow.
const TAIL = '(?:\\s*(?:[-–—|·:(\\[].{0,80})?[.!_*)\\]~]*)\\s*$';
const LEAD = '^[\\s>*_~\\-–—]*';

const BANNER_CREATED = new RegExp(
  `${LEAD}(?:this\\s+(?:issue|task|message|ticket)\\s+was\\s+)?(?:automatically\\s+)?(?:created|sent|posted|generated|triggered|filed|submitted|forwarded)\\s+(?:via|by|from|with|using|through)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?${BRAND}${TAIL}`,
  'i',
);
const BANNER_POWERED = new RegExp(`${LEAD}powered\\s+by\\s+${BRAND}${TAIL}`, 'i');
const META_LINE = /^[\s>*_~-]*(?:zap(?:ier)?(?:\s+(?:name|id|task(?:\s+id)?))?|scenario(?:\s+(?:name|id))?|make\s+(?:scenario|execution)(?:\s+id)?)\s*[:=]\s*\S.*$/i;
const SEPARATOR = /^\s*(?:-{2,}|_{3,}|\*{3,}|={3,})\s*$/;
const MAX_BANNER_LINE = 160;
const TITLE_TAG = /^\s*[[(](?:zapier|zap|make(?:\.com)?|integromat)[\])]\s*:?\s*/i;

const isBlank = (l) => l.trim() === '';
const isBanner = (l) => l.length <= MAX_BANNER_LINE && (BANNER_CREATED.test(l) || BANNER_POWERED.test(l));
const isMeta = (l) => l.length <= MAX_BANNER_LINE && META_LINE.test(l);

/** BOM, zero-width and control characters out; CRLF and NBSP normalised; 3+ blank lines become 2. */
function tidy(text) {
  return String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/ /g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text between the first begin marker and its end marker (either may be missing), or null. */
function extractMarked(text) {
  const marks = [...text.matchAll(MARKER_PATTERN)].map((m) => ({ kind: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  if (marks.length === 0) return null;
  const begin = marks.find((m) => m.kind === 'begin');
  const from = begin ? begin.end : 0;
  const end = marks.find((m) => m.kind === 'end' && m.start >= from);
  return text.slice(from, end ? end.start : text.length);
}

/** Remove a leading banner block (and its separator). @param {string[]} lines */
function stripHeader(lines) {
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i += 1;
  let j = i;
  let banners = 0;
  while (j < lines.length && (isBanner(lines[j]) || isMeta(lines[j]))) {
    if (isBanner(lines[j])) banners += 1;
    j += 1;
  }
  if (banners === 0) return { lines, removed: false };
  while (j < lines.length && (isBlank(lines[j]) || SEPARATOR.test(lines[j]))) j += 1;
  return { lines: lines.slice(j), removed: true };
}

/** Remove a trailing banner block (and its separator). @param {string[]} lines */
function stripFooter(lines) {
  let k = lines.length;
  while (k > 0 && isBlank(lines[k - 1])) k -= 1;
  let j = k;
  let banners = 0;
  while (j > 0 && (isBanner(lines[j - 1]) || isMeta(lines[j - 1]))) {
    if (isBanner(lines[j - 1])) banners += 1;
    j -= 1;
  }
  if (banners === 0) return { lines, removed: false };
  while (j > 0 && (isBlank(lines[j - 1]) || SEPARATOR.test(lines[j - 1]))) j -= 1;
  return { lines: lines.slice(0, j), removed: true };
}

/**
 * @param {unknown} body The raw issue body.
 * @returns {{ text: string, source: 'plain'|'fence'|'marked'|'banner-stripped', stripped: string[] }}
 *   `source`: how the text was arrived at. `fence` means a `titan-task-v1`
 *   block is present and the body was left for `parseTaskYaml` to read.
 */
export function normalizeIssueBody(body) {
  const raw = typeof body === 'string' ? body : '';
  const tidied = tidy(raw);
  const stripped = [];
  if (tidied !== raw.trim()) stripped.push('whitespace');

  const marked = extractMarked(tidied);
  if (marked !== null) {
    const inner = tidy(marked);
    if (inner !== '') return { text: inner, source: 'marked', stripped: [...stripped, 'outside-markers'] };
    // Markers with nothing between them: don't turn a real body into an empty task.
  }

  // A dashboard-filed (or hand-structured) body: parseTaskYaml reads only the fence.
  if (/<!--\s*titan-task-v1\s*\n/.test(tidied)) return { text: tidied, source: 'fence', stripped };

  let lines = tidied.split('\n');
  const head = stripHeader(lines);
  lines = head.lines;
  if (head.removed) stripped.push('banner-header');
  const foot = stripFooter(lines);
  lines = foot.lines;
  if (foot.removed) stripped.push('banner-footer');
  if (head.removed || foot.removed) return { text: tidy(lines.join('\n')), source: 'banner-stripped', stripped };
  return { text: tidied, source: 'plain', stripped };
}

/**
 * The issue title with any automation tag ("[Zapier]", "(Make)") removed.
 * An empty result falls back to the first line of the body, then a label.
 * @param {unknown} title
 * @param {string} [bodyText] The normalised body, for the fallback.
 */
export function normalizeIssueTitle(title, bodyText = '') {
  let t = tidy(typeof title === 'string' ? title : '').replace(/\n+/g, ' ');
  for (let i = 0; i < 3 && TITLE_TAG.test(t); i++) t = t.replace(TITLE_TAG, '').trim();
  if (t !== '') return t;
  const first = String(bodyText).split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('<!--'));
  return first ? first.slice(0, 120) : 'Untitled task';
}

export { BEGIN_MARKER, END_MARKER };
export default { normalizeIssueBody, normalizeIssueTitle, BEGIN_MARKER, END_MARKER };
