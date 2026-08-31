/**
 * @file Merges every completed task's raw output into one coherent
 * deliverable: a file tree, a markdown summary, and (via `buildZip`) a
 * downloadable archive.
 *
 * Deliberately pure — no filesystem access anywhere in this file.
 * `engine.js` owns all persistence (it already writes run state to disk
 * after every scheduler transition); this module only transforms in-memory
 * data, which keeps it trivial to unit test and reusable from a future
 * context (a CLI, a different persistence backend) without dragging disk
 * I/O along.
 *
 * File extraction: per-task parsing goes through `outputParser.js`'s
 * three-tier parser — strict fenced JSON envelope, then lenient repair
 * (including the legacy `// file: <path>` convention as its last-resort
 * fallback), then an optional injected `repair` callback standing in for a
 * cheap-model reformat pass. `extractFileBlocks`/`normalizePath` are
 * re-exported here from `envelopeParser.js`, unchanged in behavior, purely
 * so callers importing them from this file keep working; they play no part
 * in `synthesize()`'s own parsing anymore.
 *
 * Unlike the original TITAN backend, there is no `buildZip()` here — a
 * pulse posts its deliverable as an issue comment / commits it to state/,
 * it never serves a downloadable archive, so the JSZip dependency this
 * would otherwise need is dropped entirely.
 */

import { extractFileBlocks, normalizePath } from './envelopeParser.js';
import { parseTaskOutput } from './outputParser.js';

export { extractFileBlocks, normalizePath };

/**
 * @typedef {object} ExtractedFile
 * @property {string} path Normalised, traversal-safe relative path.
 * @property {string} content
 */

/**
 * Kahn's-algorithm topological sort over `dependsOn`. Falls back to the
 * input order for anything a cycle would otherwise strand (validateTaskGraph
 * already rejects cycles before a graph reaches here, but this function
 * must still terminate on malformed input rather than looping forever).
 * @template {{id: string, dependsOn: string[]}} T
 * @param {T[]} tasks
 * @returns {T[]}
 */
export function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (byId.has(dep)) indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
    }
  }

  const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const ordered = [];
  const visited = new Set();

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    ordered.push(byId.get(id));
    for (const t of tasks) {
      if ((t.dependsOn ?? []).includes(id)) {
        const remaining = (indegree.get(t.id) ?? 0) - 1;
        indegree.set(t.id, remaining);
        if (remaining === 0) queue.push(t.id);
      }
    }
  }

  // Anything left out (a cycle that slipped past validation) is appended in
  // its original order rather than dropped — better a slightly wrong order
  // than a silently incomplete synthesis.
  for (const t of tasks) {
    if (!visited.has(t.id)) ordered.push(t);
  }
  return ordered;
}

/**
 * @typedef {object} SynthesisFile
 * @property {string} path
 * @property {string} content
 * @property {string} sourceTaskId
 * @property {boolean} conflict
 * @property {string} [conflictsWithPath] Present only when `conflict` is true.
 */

/**
 * @typedef {object} SynthesisConflict
 * @property {string} path The original (contested) path.
 * @property {Array<{taskId: string, resolvedPath: string}>} versions
 */

/**
 * @typedef {object} SynthesisResult
 * @property {SynthesisFile[]} files
 * @property {SynthesisConflict[]} conflicts
 * @property {object} fileTree Nested `{dirName: {...}, "fileName.ext": SynthesisFile}`.
 * @property {string} markdownSummary
 */

/**
 * @param {string} path
 * @param {string} taskId
 * @returns {string} e.g. "src/index.js" + "task-2" -> "src/index.task-2.js"
 */
function conflictPath(path, taskId) {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = path.lastIndexOf('/');
  if (lastDot > lastSlash) {
    return `${path.slice(0, lastDot)}.${taskId}${path.slice(lastDot)}`;
  }
  return `${path}.${taskId}`;
}

/**
 * @param {object} tree
 * @param {SynthesisFile} file
 */
function addToTree(tree, file) {
  const segments = file.path.split('/');
  let node = tree;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    node[seg] = node[seg] && typeof node[seg] === 'object' && !node[seg].path ? node[seg] : {};
    node = node[seg];
  }
  node[segments[segments.length - 1]] = file;
}

/**
 * @typedef {object} TaskParseResult
 * @property {1|2|3|null} tier
 * @property {boolean} malformed
 */

/**
 * Merge every completed task's output into one deliverable. Async since
 * `outputParser.js`'s tier-3 repair pass is itself async (an optional
 * cheap-model reformat call), so any task's parse can await it.
 * @param {{ sharedContext: string, tasks: Array<{id: string, title: string, dependsOn: string[]}> }} graph
 * @param {Map<string, { state: string, output: string|null, assignment: {modelId: string, pool: string}|null, error: {code:string,message:string}|null, envelopeTier?: 1|2|3|null }>} tasksById
 * @param {{ repair?: (text: string) => Promise<string> }} [options] Forwarded to `parseTaskOutput` for every task.
 * @returns {Promise<SynthesisResult & { taskParseResults: Record<string, TaskParseResult> }>}
 */
export async function synthesize(graph, tasksById, options = {}) {
  const ordered = topoOrder(graph.tasks);

  /** @type {Map<string, Array<{taskId: string, content: string}>>} */
  const byPath = new Map();
  const summaryLines = [];
  /** @type {Record<string, TaskParseResult>} */
  const taskParseResults = {};

  for (const taskDef of ordered) {
    const task = tasksById.get(taskDef.id);
    if (!task || task.state !== 'complete' || !task.output) {
      const reason = task ? task.state : 'missing';
      summaryLines.push(`- **${taskDef.title}** (\`${taskDef.id}\`) — ${reason}, no output.`);
      continue;
    }

    const parsed = await parseTaskOutput(task.output, options);
    taskParseResults[taskDef.id] = { tier: parsed.tier, malformed: parsed.malformed };
    // Recorded on the live task object — engine.js persists task state
    // after every transition, so this reaches TaskDetailDrawer the same
    // way `task.output`/`task.error` already do. `envelopeTier` is only
    // set here if a prior repair pass didn't already claim it: a repaired
    // task's output now parses as an ordinary tier-1/2 success (that's
    // what makes the repair a repair), but the fact that it took a tier-3
    // round trip to get there is the more useful thing to show — this
    // must not overwrite that back down to 1 or 2.
    if (task.envelopeTier === undefined) task.envelopeTier = parsed.tier;
    const modelLabel = task.assignment?.modelId ?? 'unknown model';

    if (parsed.malformed) {
      summaryLines.push(
        `- **${taskDef.title}** (\`${taskDef.id}\`) — completed via \`${modelLabel}\`; output looked like a files-envelope attempt but could not be parsed by any tier (malformed_output).`,
      );
    } else if (parsed.files.length === 0) {
      summaryLines.push(
        `- **${taskDef.title}** (\`${taskDef.id}\`) — completed via \`${modelLabel}\`; freeform output, no file blocks detected.`,
      );
    } else {
      const paths = parsed.files.map((f) => `\`${f.path}\``).join(', ');
      const tierNote = parsed.tier === 1 ? '' : ` (tier ${parsed.tier} parse)`;
      summaryLines.push(
        `- **${taskDef.title}** (\`${taskDef.id}\`) — completed via \`${modelLabel}\`; produced ${parsed.files.length} file(s)${tierNote}: ${paths}.`,
      );
    }

    for (const block of parsed.files) {
      const list = byPath.get(block.path) ?? [];
      list.push({ taskId: taskDef.id, content: block.content });
      byPath.set(block.path, list);
    }
  }

  /** @type {SynthesisFile[]} */
  const files = [];
  /** @type {SynthesisConflict[]} */
  const conflicts = [];
  const fileTree = {};

  for (const [path, versions] of byPath) {
    if (versions.length === 1) {
      const file = { path, content: versions[0].content, sourceTaskId: versions[0].taskId, conflict: false };
      files.push(file);
      addToTree(fileTree, file);
      continue;
    }

    // Conflict: two or more agents wrote the same path. Both versions are
    // kept — one at the original path, the rest disambiguated by task id —
    // and the conflict itself is recorded so the UI can flag it prominently
    // rather than silently picking a winner.
    const conflictVersions = versions.map((v, i) => {
      const resolvedPath = i === 0 ? path : conflictPath(path, v.taskId);
      const file = { path: resolvedPath, content: v.content, sourceTaskId: v.taskId, conflict: true, conflictsWithPath: path };
      files.push(file);
      addToTree(fileTree, file);
      return { taskId: v.taskId, resolvedPath };
    });
    conflicts.push({ path, versions: conflictVersions });
  }

  const markdownSummary = buildMarkdownSummary(graph, ordered, tasksById, summaryLines, conflicts, files);

  return { files, conflicts, fileTree, markdownSummary, taskParseResults };
}

/**
 * @param {object} graph
 * @param {Array<{id: string}>} ordered
 * @param {Map<string, object>} tasksById
 * @param {string[]} summaryLines
 * @param {SynthesisConflict[]} conflicts
 * @param {SynthesisFile[]} files
 * @returns {string}
 */
function buildMarkdownSummary(graph, ordered, tasksById, summaryLines, conflicts, files) {
  const total = ordered.length;
  const complete = ordered.filter((t) => tasksById.get(t.id)?.state === 'complete').length;

  const parts = [
    '# Orchestration Summary',
    '',
    `${complete}/${total} tasks completed.`,
    '',
    '## Tasks',
    '',
    ...summaryLines,
  ];

  if (conflicts.length > 0) {
    parts.push('', '## File conflicts', '');
    for (const c of conflicts) {
      parts.push(`- \`${c.path}\` was written by ${c.versions.length} tasks: ` +
        c.versions.map((v) => `\`${v.taskId}\` (kept as \`${v.resolvedPath}\`)`).join(', '));
    }
  }

  if (files.length > 0) {
    parts.push('', '## Files produced', '');
    for (const f of files.filter((x) => !x.conflict)) parts.push(`- \`${f.path}\``);
  }

  if (graph.sharedContext) {
    parts.push('', '## Shared context used for this run', '', graph.sharedContext);
  }

  return parts.join('\n');
}

export default synthesize;
