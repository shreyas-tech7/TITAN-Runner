/**
 * @file Parser for the HTML-comment-wrapped YAML block the dashboard's
 * task-filing modal embeds in every issue it creates
 * (`dashboard/lib/taskYaml.ts` — kept in exact lockstep with this file;
 * change one, change both).
 *
 * Task instructions, section 1: "a machine-readable YAML block in the body
 * that the pulse parses. Never scrape prose out of the issue body." This
 * is exactly what `parseTaskYaml()` does: it locates the `<!-- titan-task-v1
 * ... -->` fence and parses ONLY what is inside it — the human-readable
 * prose the dashboard also writes above that fence (and anything a human
 * added by editing the issue afterward) is never read as task content.
 *
 * A hand-written parser for this one fixed, flat schema, not a general
 * YAML library — this repo is deliberately dependency-free (see
 * `src/github.js`'s header for the same reasoning applied to the GitHub
 * client). An issue with no fence at all (every issue filed through the
 * original GitHub issue template, before this feature existed, and any
 * filed directly on github.com without going through the dashboard) is not
 * an error — `issueSync.js` falls back to the pre-existing whole-body-as-
 * prompt behavior for those, so nothing already shipped breaks.
 */

const FENCE_PATTERN = /<!--\s*titan-task-v1\s*\n([\s\S]*?)-->/;
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);
const VALID_ROUTING_HINTS = new Set(['fast', 'cheap', 'careful', 'any']);

/** Reverse of the browser's `quoteScalar()` — unescape `\\` and `\"`. */
function unquoteScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/**
 * @param {string} issueBody
 * @returns {{title: string, description: string, priority: 'low'|'normal'|'high',
 *   routingHint: 'fast'|'cheap'|'careful'|'any', filedVia: string|null}|null}
 *   `null` when no titan-task-v1 fence is present, or the fields inside it
 *   don't add up to a usable task (missing title/description) — the caller
 *   falls back to the legacy whole-body prompt in either case.
 */
export function parseTaskYaml(issueBody) {
  if (typeof issueBody !== 'string') return null;
  const match = issueBody.match(FENCE_PATTERN);
  if (!match) return null;

  const lines = match[1].split('\n');
  /** @type {Record<string, string>} */
  const scalars = {};
  let description = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scalarMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!scalarMatch) continue;
    const [, key, rest] = scalarMatch;

    if (key === 'description' && rest.trim() === '|') {
      const blockLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l === '') {
          blockLines.push('');
          continue;
        }
        if (!l.startsWith('  ')) break; // dedent ends the block scalar
        blockLines.push(l.slice(2));
      }
      // Trailing blank lines are formatting, not content — trim them the
      // way a real `|` block scalar's default chomping would.
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') blockLines.pop();
      description = blockLines.join('\n');
      i = j - 1;
      continue;
    }

    scalars[key] = unquoteScalar(rest);
  }

  const title = typeof scalars.title === 'string' ? scalars.title.trim() : '';
  if (title.length === 0 || description === null || description.trim().length === 0) return null;

  const priority = VALID_PRIORITIES.has(scalars.priority) ? scalars.priority : 'normal';
  const routingHint = VALID_ROUTING_HINTS.has(scalars.routingHint) ? scalars.routingHint : 'any';

  return { title, description, priority, routingHint, filedVia: scalars.filedVia ?? null };
}

export default parseTaskYaml;
