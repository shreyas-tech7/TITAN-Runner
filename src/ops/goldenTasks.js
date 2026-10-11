/**
 * @file The golden tasks (RO3). Fifteen small tasks that cover the 12 categories of the shared taxonomy.
 *
 * Each task has a deterministic checker: an exact answer, a regex, a JSON schema, or a unit test for code. No model
 * judges another model. Each task also holds a `reference` answer that must pass its checker and a `wrong` answer that
 * must fail it. The tests run both, so a broken checker cannot go unseen.
 *
 * Change a task, and `EVAL_VERSION` must change too. `test/ops-eval.test.js` pins a fingerprint of this list and fails
 * when the tasks change and the version does not. A score from an old version is not comparable with a new one.
 */
import { createHash } from 'node:crypto';
import { ASPECT_CATEGORIES } from '../orchestrator/taxonomy.js';

export const EVAL_VERSION = 'v1';

const ONLY = 'Reply with only';

/**
 * @typedef {object} GoldenTask
 * @property {string} id
 * @property {string} category One of the taxonomy categories.
 * @property {string} prompt
 * @property {{ type: 'exact'|'regex'|'json'|'code', [key: string]: any }} checker
 * @property {string} reference An answer that passes.
 * @property {string} wrong An answer that fails.
 */

/** @type {GoldenTask[]} */
export const GOLDEN_TASKS = [
  {
    id: 'arch-event-pattern', category: 'architecture',
    prompt: `Many parts of a system must react to an event without knowing each other. Which design pattern fits: observer, singleton, factory, or adapter? ${ONLY} the name of the pattern.`,
    checker: { type: 'regex', pattern: '^\\W*(observer|pub[- ]?sub|publish[- ]subscribe)\\W*$', flags: 'i' },
    reference: 'observer', wrong: 'singleton',
  },
  {
    id: 'code-slugify', category: 'code-generation',
    prompt: 'Write a JavaScript function slugify(title) that lowercases the text, removes every character that is not a letter, a digit, or a space, then turns each run of spaces into one hyphen. Reply with only the code.',
    checker: { type: 'code', fn: 'slugify', cases: [{ args: ['Hello World'], expect: 'hello-world' }, { args: ['  A  B  '], expect: 'a-b' }, { args: ['Rock & Roll!'], expect: 'rock-roll' }, { args: ['x'], expect: 'x' }] },
    reference: 'function slugify(t){return t.toLowerCase().replace(/[^a-z0-9 ]/g,"").trim().split(/ +/).join("-");}',
    wrong: 'function slugify(t){return t;}',
  },
  {
    id: 'code-sum-evens', category: 'code-generation',
    prompt: 'Write a JavaScript function sumEvens(numbers) that returns the sum of the even numbers in an array. An empty array gives 0. Reply with only the code.',
    checker: { type: 'code', fn: 'sumEvens', cases: [{ args: [[1, 2, 3, 4]], expect: 6 }, { args: [[]], expect: 0 }, { args: [[7, 9]], expect: 0 }, { args: [[-2, 2, 10]], expect: 10 }] },
    reference: 'function sumEvens(a){return a.filter(n=>n%2===0).reduce((s,n)=>s+n,0);}',
    wrong: 'function sumEvens(a){return a.reduce((s,n)=>s+n,0);}',
  },
  {
    id: 'refactor-total', category: 'refactoring',
    prompt: 'Refactor this function to use Array.prototype.reduce and no for loop. Keep the same name and the same result. Reply with only the code.\n\nfunction total(items) {\n  let t = 0;\n  for (const i of items) { t += i.price * i.qty; }\n  return t;\n}',
    checker: { type: 'code', fn: 'total', requires: ['\\.reduce\\('], forbids: ['\\bfor\\s*\\('], cases: [{ args: [[{ price: 2, qty: 3 }, { price: 5, qty: 1 }]], expect: 11 }, { args: [[]], expect: 0 }] },
    reference: 'function total(items){return items.reduce((t,i)=>t+i.price*i.qty,0);}',
    wrong: 'function total(items){let t=0;for(const i of items){t+=i.price*i.qty;}return t;}',
  },
  {
    id: 'test-leap-years', category: 'testing',
    prompt: `Which four years are the best boundary inputs to test an isLeapYear function: 1900, 2000, 2023, 2024? ${ONLY} JSON like {"years": [1900, 2000]} that lists them.`,
    checker: { type: 'json', schema: { type: 'object', required: ['years'], properties: { years: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'integer' } } } }, includesAll: { path: 'years', values: [1900, 2000] } },
    reference: '{"years": [1900, 2000, 2023, 2024]}', wrong: '{"years": [2023, 2024]}',
  },
  {
    id: 'debug-max-negative', category: 'debugging',
    prompt: 'This function returns a wrong result when every number is negative. Fix it. Keep the name. Reply with only the code.\n\nfunction maxOf(a) {\n  let m = 0;\n  for (const x of a) { if (x > m) m = x; }\n  return m;\n}',
    checker: { type: 'code', fn: 'maxOf', cases: [{ args: [[-3, -1, -2]], expect: -1 }, { args: [[4, 9, 2]], expect: 9 }, { args: [[-5]], expect: -5 }] },
    reference: 'function maxOf(a){let m=a[0];for(const x of a){if(x>m)m=x;}return m;}',
    wrong: 'function maxOf(a){let m=0;for(const x of a){if(x>m)m=x;}return m;}',
  },
  {
    id: 'debug-output', category: 'debugging',
    prompt: `What number does this print? ${ONLY} the number.\n\nconsole.log([1, 2, 3].map(x => x * 2).filter(x => x > 2).length)`,
    checker: { type: 'exact', answer: '2' },
    reference: '2', wrong: '3',
  },
  {
    id: 'doc-jsdoc', category: 'documentation',
    prompt: `Write one JSDoc line for a parameter called name of type string. Its text is: the user name. ${ONLY} that one line.`,
    checker: { type: 'regex', pattern: '@param\\s+\\{string\\}\\s+name\\b.*user name', flags: 'i' },
    reference: '@param {string} name - the user name', wrong: '@returns {string} the user name',
  },
  {
    id: 'sec-sql-injection', category: 'security-review',
    prompt: `Does this code allow SQL injection? ${ONLY} YES or NO.\n\ndb.query('SELECT * FROM users WHERE id = ' + req.params.id)`,
    checker: { type: 'exact', answer: 'yes' },
    reference: 'YES', wrong: 'NO',
  },
  {
    id: 'perf-has-duplicate', category: 'performance',
    prompt: 'Write a JavaScript function hasDuplicate(array) that returns true when the array has a repeated value. It must run in linear time, so use a Set. Reply with only the code.',
    checker: { type: 'code', fn: 'hasDuplicate', requires: ['new\\s+Set'], cases: [{ args: [[1, 2, 3, 1]], expect: true }, { args: [[1, 2, 3]], expect: false }, { args: [[]], expect: false }, { args: [['a', 'b', 'a']], expect: true }] },
    reference: 'function hasDuplicate(a){const s=new Set();for(const x of a){if(s.has(x))return true;s.add(x);}return false;}',
    wrong: 'function hasDuplicate(a){for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]===a[j])return true;return false;}',
  },
  {
    id: 'data-posts-table', category: 'data-modeling',
    prompt: `Design a database table for blog posts. ${ONLY} JSON like {"table": "posts", "columns": ["id", "title"]} where columns lists id, title, body, and author_id.`,
    checker: { type: 'json', schema: { type: 'object', required: ['table', 'columns'], properties: { table: { type: 'string' }, columns: { type: 'array', minItems: 4, maxItems: 20, items: { type: 'string' } } } }, includesAll: { path: 'columns', values: ['id', 'title', 'body', 'author_id'] } },
    reference: '{"table": "posts", "columns": ["id", "title", "body", "author_id", "created_at"]}', wrong: '{"table": "posts", "columns": ["id", "title"]}',
  },
  {
    id: 'devops-docker-ps', category: 'devops',
    prompt: `Write the one shell command that lists the running Docker containers. ${ONLY} the command.`,
    checker: { type: 'regex', pattern: '^\\W*docker\\s+(container\\s+ls|container\\s+list|ps)\\b[^\\n]*$', flags: 'i' },
    reference: 'docker ps', wrong: 'docker images',
  },
  {
    id: 'ui-email-input', category: 'ui-implementation',
    prompt: `Write one HTML tag for a text field with the id email and the type email. ${ONLY} the tag.`,
    checker: { type: 'regex', pattern: '^(?=[\\s\\S]*<input)(?=[\\s\\S]*type=["\']email["\'])(?=[\\s\\S]*id=["\']email["\'])', flags: 'i' },
    reference: '<input type="email" id="email">', wrong: '<input type="text" id="email">',
  },
  {
    id: 'research-iphone-year', category: 'research',
    prompt: `In which year did the first iPhone go on sale? ${ONLY} the four digit year.`,
    checker: { type: 'exact', answer: '2007' },
    reference: '2007', wrong: '2010',
  },
  {
    id: 'research-closest-planet', category: 'research',
    prompt: `Which planet is closest to the Sun? ${ONLY} the name of the planet.`,
    checker: { type: 'exact', answer: 'mercury' },
    reference: 'Mercury', wrong: 'Venus',
  },
];

/** A short hash of the task list. The test pins it. */
export function tasksFingerprint(tasks = GOLDEN_TASKS) {
  return createHash('sha256').update(JSON.stringify(tasks.map((t) => [t.id, t.category, t.prompt, t.checker]))).digest('hex').slice(0, 12);
}

export const CATEGORIES_COVERED = Object.freeze([...new Set(GOLDEN_TASKS.map((t) => t.category))]);

/**
 * Choose the tasks that fit a call budget. Every model runs the same tasks, so scores compare. The choice goes around
 * the categories, so each one stays covered for as long as the budget allows.
 * @param {GoldenTask[]} tasks
 * @param {number} modelCount
 * @param {number} maxCalls
 */
export function selectTasks(tasks, modelCount, maxCalls) {
  if (modelCount <= 0) return [];
  const per = Math.max(0, Math.floor(maxCalls / modelCount));
  if (per >= tasks.length) return [...tasks];
  const byCategory = new Map(ASPECT_CATEGORIES.map((c) => [c, tasks.filter((t) => t.category === c)]));
  const chosen = [];
  for (let round = 0; chosen.length < per; round += 1) {
    let added = false;
    for (const list of byCategory.values()) {
      if (list[round] && chosen.length < per) {
        chosen.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return tasks.filter((t) => chosen.includes(t));
}

export default { GOLDEN_TASKS, EVAL_VERSION, tasksFingerprint, selectTasks };
