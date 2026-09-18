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
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_ROUTING_HINTS = new Set(['fast', 'cheap', 'careful', 'any']);
const TASK_ID_PATTERN = /^(issue|manual)-[0-9]+$/;
const MAX_DEPENDENCIES = 8;
const MAX_TTL_HOURS = 24 * 30;
const VALID_AUTONOMY = new Set(['dry-run', 'propose', 'approval', 'autonomous']);

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

  // Lifecycle fields (all optional, all validated, all bounded — this text
  // is attacker-adjacent even from an authorized filer):
  //   dependsOn: issue-12, issue-13   — task ids this one waits for
  //   deadline: 2026-10-01T00:00:00Z  — ISO 8601; runs first as it nears, expires after
  //   ttlHours: 48                    — give up if not finished within this window
  const dependsOn = typeof scalars.dependsOn === 'string'
    ? [...new Set(scalars.dependsOn.split(/[,\s]+/).map((s) => s.trim()).filter((s) => TASK_ID_PATTERN.test(s)))].slice(0, MAX_DEPENDENCIES)
    : [];
  const deadlineMs = typeof scalars.deadline === 'string' ? Date.parse(scalars.deadline) : NaN;
  const deadline = Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
  const ttlRaw = Number(scalars.ttlHours);
  const ttlHours = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, MAX_TTL_HOURS) : null;
  //   autonomy: propose               — this task's own level; the engine runs at the
  //                                     stricter of it and state/control.json, so a filer can
  //                                     only ever ask for *less* autonomy, never more
  const autonomy = VALID_AUTONOMY.has(scalars.autonomy) ? scalars.autonomy : null;

  return { title, description, priority, routingHint, filedVia: scalars.filedVia ?? null, dependsOn, deadline, ttlHours, autonomy };
}

export default parseTaskYaml;
