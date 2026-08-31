/**
 * The machine-readable block the task-filing modal embeds in every issue it
 * creates (task instructions, section 1: "a machine-readable YAML block in
 * the body that the pulse parses. Never scrape prose out of the issue
 * body."). Wrapped in an HTML comment so it renders invisibly in GitHub's
 * issue UI — a human reading the issue sees only the prose rendering above
 * it; the pulse (`src/lib/taskYaml.js`, kept in exact lockstep with this
 * file) reads only this block, never anything else in the body.
 *
 * This is real YAML (a human with `yaml.safeLoad` could parse it too), but
 * both ends of it are hand-written against this one fixed, flat schema
 * rather than pulling in a full YAML library — this repo (both the browser
 * bundle and the Node side) is deliberately dependency-free, and a general
 * parser is not needed to round-trip four flat fields plus one block
 * scalar. See `src/lib/taskYaml.js`'s header for the matching parser.
 */
export type Priority = "low" | "normal" | "high";
export type RoutingHint = "fast" | "cheap" | "careful" | "any";

export interface TaskInput {
  title: string;
  description: string;
  priority: Priority;
  routingHint: RoutingHint;
}

const FENCE_START = "<!-- titan-task-v1";
const FENCE_END = "-->";

/** Double-quoted YAML scalar escaping — backslash and double-quote only, the two this generator's own input can ever contain that would break the quoting. */
function quoteScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A `|` (literal block scalar), 2-space indented, blank-line-safe. */
function blockScalar(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  return lines.map((line) => (line.length > 0 ? `  ${line}` : "")).join("\n");
}

export function buildYamlBlock(input: TaskInput): string {
  return [
    FENCE_START,
    `title: ${quoteScalar(input.title)}`,
    `priority: ${input.priority}`,
    `routingHint: ${input.routingHint}`,
    `filedVia: dashboard`,
    `description: |`,
    blockScalar(input.description),
    FENCE_END,
  ].join("\n");
}

/**
 * The full GitHub issue body: a human-readable rendering first (what shows
 * up in GitHub's UI, email notifications, etc.), then the hidden YAML
 * block. The pulse only ever reads the block; this prose exists purely for
 * a human looking at the issue directly.
 */
export function buildIssueBody(input: TaskInput): string {
  const priorityLabel = input.priority[0].toUpperCase() + input.priority.slice(1);
  const hintLabel = input.routingHint === "any" ? "any (no preference)" : input.routingHint;
  return [
    input.description.trim(),
    "",
    `**Priority:** ${priorityLabel} · **Routing hint:** ${hintLabel}`,
    "",
    buildYamlBlock(input),
    "",
    "---",
    "_Filed via the TITAN-Runner dashboard's task-filing modal._",
  ].join("\n");
}

export const TITAN_TASK_LABEL = "titan-task";
