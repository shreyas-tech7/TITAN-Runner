/**
 * @file Turns one pasted master prompt into an ordered task graph.
 *
 * Live mode: sends a structured decomposition prompt to the strongest
 * available reasoning model — Freebuff preferred, unless it is already busy
 * (its hard 1-in-flight cap means "busy" is common and must not block a
 * decomposition behind an unrelated task) — parses the response defensively,
 * validates the graph (no cycles, no dangling `dependsOn` ids, within
 * `maxTasks`), retries once with the validation errors appended if it
 * failed, and falls back to a single-task graph containing the raw master
 * prompt if the retry also fails.
 *
 * Offline mode returns a fixed, realistic sample graph — same pattern the
 * agent adapters (`agents/freebuffAgent.js`, `agents/opencodeAgent.js`) use
 * everywhere else in this codebase: an offline call ignores its real input
 * and returns canned fixture data, so the whole system is exercisable with
 * zero network calls. It still goes through the same validator as the live
 * path (nothing about validation is skipped in offline mode), which is what
 * proves the validator itself works against a graph shaped like a real one.
 */

import { config } from '../config.js';
import { ASPECT_CATEGORIES, isAspectCategory, isComplexityLevel } from './taxonomy.js';
import { parseProbeJson } from './capabilityRegistry.js';

/** Order of preference for which pool answers the decomposition prompt. */
const DECOMPOSER_POOL_ORDER = ['freebuff', 'phase2', 'opencode'];

/**
 * @typedef {object} DecomposedTask
 * @property {string} id
 * @property {string} title
 * @property {string} aspect
 * @property {string} description
 * @property {string[]} dependsOn
 * @property {'low'|'medium'|'high'} estimatedComplexity
 * @property {string} deliverable
 */

/**
 * @typedef {object} TaskGraph
 * @property {string} sharedContext
 * @property {DecomposedTask[]} tasks
 */

/* -------------------------------------------------------------------------- */
/* Prompt building                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} masterPrompt
 * @param {number} maxTasks
 * @param {string[]} [retryErrors] Validation errors from a prior attempt, if this is the retry.
 * @returns {string}
 */
export function buildDecomposePrompt(masterPrompt, maxTasks, retryErrors) {
  const categories = ASPECT_CATEGORIES.join(', ');
  const base =
    `You are the decomposer for a multi-agent build system. Break the following master prompt ` +
    `into an ordered task graph. Respond with STRICT JSON ONLY — no prose, no markdown code fences ` +
    `— matching exactly this shape:\n` +
    `{"sharedContext": string, "tasks": [{"id": string, "title": string, "aspect": string, ` +
    `"description": string, "dependsOn": string[], "estimatedComplexity": "low"|"medium"|"high", ` +
    `"deliverable": string}]}\n\n` +
    `Rules:\n` +
    `- "aspect" must be exactly one of: ${categories}.\n` +
    `- "dependsOn" lists ids of other tasks in this same array that must complete first; use [] for none.\n` +
    `- Generate at most ${maxTasks} tasks.\n` +
    `- "sharedContext" is written ONCE, covering the project's overall goal, the tech stack, naming ` +
    `conventions, and any interfaces/contracts that cross task boundaries — every agent sees only ` +
    `this shared context plus its own task, so it must carry everything needed to keep every agent's ` +
    `output consistent with every other agent's.\n` +
    `- The dependency graph must have no cycles, and every id in "dependsOn" must exist in "tasks".\n\n` +
    `Master prompt:\n${masterPrompt}`;

  if (!retryErrors || retryErrors.length === 0) return base;

  return (
    `${base}\n\nYour previous response failed validation for these reasons:\n` +
    retryErrors.map((e) => `- ${e}`).join('\n') +
    `\nFix these issues and respond again with ONLY the corrected JSON object.`
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {DecomposedTask[]} tasks
 * @returns {string[]|null} A dependency cycle as an array of ids, or null if acyclic.
 */
function findCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  /** @type {Map<string, 0|1|2>} 0 = unvisited, 1 = in progress, 2 = done. */
  const state = new Map();
  const stack = [];

  function visit(id) {
    state.set(id, 1);
    stack.push(id);
    const task = byId.get(id);
    for (const dep of task?.dependsOn ?? []) {
      const depState = state.get(dep);
      if (depState === 1) {
        const cycleStart = stack.indexOf(dep);
        return [...stack.slice(cycleStart), dep];
      }
      if (depState !== 2 && byId.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    state.set(id, 2);
    stack.pop();
    return null;
  }

  for (const task of tasks) {
    if (state.get(task.id) === undefined) {
      const found = visit(task.id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {unknown} tasks
 * @param {number} maxTasks
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTaskGraph(tasks, maxTasks) {
  const errors = [];

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, errors: ['"tasks" must be a non-empty array'] };
  }
  if (tasks.length > maxTasks) {
    errors.push(`graph has ${tasks.length} tasks, which exceeds maxTasks=${maxTasks}`);
  }

  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || t.id.trim().length === 0) {
      errors.push('every task needs a non-empty string "id"');
      continue;
    }
    if (ids.has(t.id)) errors.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
  }

  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') continue;
    if (!isAspectCategory(t.aspect)) {
      errors.push(`task "${t.id}" has an invalid "aspect": "${t.aspect}"`);
    }
    if (!isComplexityLevel(t.estimatedComplexity)) {
      errors.push(`task "${t.id}" has an invalid "estimatedComplexity": "${t.estimatedComplexity}"`);
    }
    if (typeof t.title !== 'string' || t.title.trim().length === 0) {
      errors.push(`task "${t.id}" needs a non-empty "title"`);
    }
    if (typeof t.description !== 'string' || t.description.trim().length === 0) {
      errors.push(`task "${t.id}" needs a non-empty "description"`);
    }
    if (typeof t.deliverable !== 'string' || t.deliverable.trim().length === 0) {
      errors.push(`task "${t.id}" needs a non-empty "deliverable"`);
    }
    if (!Array.isArray(t.dependsOn)) {
      errors.push(`task "${t.id}" needs "dependsOn" to be an array (use [] for none)`);
    } else {
      for (const dep of t.dependsOn) {
        if (!ids.has(dep)) errors.push(`task "${t.id}" depends on unknown id "${dep}"`);
      }
    }
  }

  if (errors.length === 0) {
    const cycle = findCycle(tasks);
    if (cycle) errors.push(`dependency cycle detected: ${cycle.join(' -> ')}`);
  }

  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Fallback + offline fixture                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} masterPrompt
 * @returns {TaskGraph}
 */
export function singleTaskFallback(masterPrompt) {
  const prompt = typeof masterPrompt === 'string' && masterPrompt.trim().length > 0
    ? masterPrompt
    : '(empty master prompt)';
  return {
    sharedContext:
      'Decomposition was not available (no reasoning model could produce a valid task graph). ' +
      'This run has a single task carrying the entire master prompt verbatim.',
    tasks: [
      {
        id: 'task-1',
        title: 'Complete the master prompt as a single task',
        aspect: 'architecture',
        description: prompt,
        dependsOn: [],
        estimatedComplexity: 'high',
        deliverable: 'A complete solution addressing the master prompt in full.',
      },
    ],
  };
}

/**
 * A realistic multi-task sample graph, returned unconditionally in offline
 * mode. Deliberately ignores the real master prompt text, same as every
 * other offline fixture in this codebase (see services/base.js's
 * `#offlineChat()`) — the point is exercising the pipeline end to end with
 * zero network calls, not simulating real decomposition.
 * @returns {TaskGraph}
 */
export function offlineSampleGraph() {
  return {
    sharedContext:
      'Project: a task-manager web app — a small Express + SQLite REST API behind a React ' +
      'frontend. Tech stack: Node.js 20, Express 5, SQLite, React 18, Vite, plain CSS (no UI ' +
      'framework). Naming: REST routes are kebab-case plural nouns (/api/tasks, /api/task-lists); ' +
      'JS/TS identifiers are camelCase; SQL columns are snake_case. Cross-task interface: every ' +
      'task record is {id: number, title: string, done: boolean, listId: number, createdAt: string ' +
      '(ISO 8601)} — the backend task and the frontend task must agree on this shape exactly.',
    tasks: [
      {
        id: 'schema',
        title: 'Design the SQLite schema',
        aspect: 'data-modeling',
        description: 'Design tables for task lists and tasks, with foreign keys and indexes for the common queries (tasks by list, tasks by done state).',
        dependsOn: [],
        estimatedComplexity: 'medium',
        deliverable: 'A migrations/*.sql file defining the schema.',
      },
      {
        id: 'api',
        title: 'Build the REST API',
        aspect: 'code-generation',
        description: 'Implement CRUD routes for task lists and tasks per the shared interface contract above, on top of the schema from the "schema" task.',
        dependsOn: ['schema'],
        estimatedComplexity: 'high',
        deliverable: 'Express route handlers plus a small data-access layer.',
      },
      {
        id: 'frontend',
        title: 'Build the React frontend',
        aspect: 'ui-implementation',
        description: 'A single-page task list view: add/complete/delete tasks, switch between lists, calling the API from the "api" task.',
        dependsOn: ['api'],
        estimatedComplexity: 'high',
        deliverable: 'React components plus a small API client module.',
      },
      {
        id: 'tests',
        title: 'Write API integration tests',
        aspect: 'testing',
        description: 'Cover the CRUD routes from the "api" task: create, list, update, delete, and the two common query filters.',
        dependsOn: ['api'],
        estimatedComplexity: 'medium',
        deliverable: 'A test file exercising every route with both success and error cases.',
      },
      {
        id: 'security',
        title: 'Security review of the API layer',
        aspect: 'security-review',
        description: 'Review the "api" task\'s routes for injection, missing input validation, and unbounded query results.',
        dependsOn: ['api'],
        estimatedComplexity: 'low',
        deliverable: 'A short written list of findings, each with a concrete fix.',
      },
      {
        id: 'docs',
        title: 'Write the README',
        aspect: 'documentation',
        description: 'Document how to run the app locally, the API routes from the "api" task, and the schema from the "schema" task.',
        dependsOn: ['api', 'frontend'],
        estimatedComplexity: 'low',
        deliverable: 'A README.md covering setup, the API surface, and the schema.',
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Pool selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Freebuff preferred; skipped if already at its concurrency cap (never wait
 * for it — decomposition must not block behind an unrelated in-flight task).
 * Falls through to Phase 2, then OpenCode.
 * @param {Record<string, import('../../agents/AgentAdapter.js').AgentAdapter>} pools
 * @returns {import('../../agents/AgentAdapter.js').AgentAdapter|null}
 */
export function pickDecomposerAdapter(pools) {
  for (const poolName of DECOMPOSER_POOL_ORDER) {
    const adapter = pools?.[poolName];
    if (!adapter) continue;
    if (adapter.inFlight >= adapter.maxConcurrency) continue;
    return adapter;
  }
  // Nothing free right now — fall back to whichever exists, even busy
  // (the adapter's own semaphore will queue the call rather than reject it).
  for (const poolName of DECOMPOSER_POOL_ORDER) {
    if (pools?.[poolName]) return pools[poolName];
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} masterPrompt
 * @param {{ pools?: Record<string, object>, maxTasks?: number }} [options]
 * @returns {Promise<TaskGraph>}
 */
export async function decompose(masterPrompt, options = {}) {
  const { pools = {}, maxTasks = config.orchestrator?.maxSubtasksPerRun ?? 8 } = options;

  if (config.dryRun) {
    // Still validated — proves the validator accepts a realistically-shaped
    // graph, and keeps the offline path honest rather than hand-waved.
    const graph = offlineSampleGraph();
    const validation = validateTaskGraph(graph.tasks, maxTasks);
    if (!validation.ok) return singleTaskFallback(masterPrompt);
    return graph;
  }

  const adapter = pickDecomposerAdapter(pools);
  if (!adapter) return singleTaskFallback(masterPrompt);

  const first = await attemptDecompose(adapter, masterPrompt, maxTasks);
  if (first.ok) return first.graph;

  const firstErrors = /** @type {{ ok: false, errors: string[] }} */ (first).errors;
  const retry = await attemptDecompose(adapter, masterPrompt, maxTasks, firstErrors);
  if (retry.ok) return retry.graph;

  return singleTaskFallback(masterPrompt);
}

/**
 * One decomposition call plus defensive parsing and validation. Exported
 * separately from `decompose()` so it can be unit-tested directly with a
 * fake adapter — `decompose()`'s own `config.dryRun` branch always
 * takes the offline path in this test environment (frozen at import time,
 * same as everywhere else in this codebase; see phase2Agent's test suite
 * for the identical constraint), so this is the only way to exercise the
 * live retry/parse/validate flow at all.
 * @param {object} adapter
 * @param {string} masterPrompt
 * @param {number} maxTasks
 * @param {string[]} [retryErrors]
 * @returns {Promise<{ ok: true, graph: TaskGraph } | { ok: false, errors: string[] }>}
 */
export async function attemptDecompose(adapter, masterPrompt, maxTasks, retryErrors) {
  const promptText = buildDecomposePrompt(masterPrompt, maxTasks, retryErrors);
  /** @type {import('../../agents/AgentAdapter.js').AdapterTask} */
  const pseudoTask = {
    id: 'decompose',
    title: 'Decompose the master prompt into a task graph',
    aspect: 'architecture',
    description: promptText,
    deliverable: 'Strict JSON task graph',
  };

  const result = await adapter.execute(pseudoTask, '', {});
  if (!result.ok) return { ok: false, errors: [result.error?.message ?? 'decomposition call failed'] };

  const parsed = parseProbeJson(result.output);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: ['response was not parsable JSON'] };
  }

  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : null;
  const validation = validateTaskGraph(tasks, maxTasks);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const sharedContext = typeof parsed.sharedContext === 'string' ? parsed.sharedContext : '';
  return { ok: true, graph: { sharedContext, tasks } };
}

export default decompose;
