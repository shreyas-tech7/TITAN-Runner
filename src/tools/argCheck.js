/**
 * @file Checks the arguments of a tool call against the schema of the tool (RT4).
 *
 * A model writes the arguments. The arguments are untrusted input. This check runs before any tool code runs.
 * It reports EVERY bad field by name, not only the first one, so the model can fix the whole call in one turn.
 *
 * Rules:
 *   - `args` must be an object. A missing `args` counts as an empty object.
 *   - A property that the schema does not list is an error. This holds even if the schema forgot to say so.
 *   - Each error names its field, such as `path` or `input.url`. The field `args` stands for the whole object.
 */
import { validate } from '../lib/validate.js';

/** Most problems that one call reports. */
export const MAX_FIELD_ERRORS = 20;

/**
 * Turn a validator path into a field name. `$` is the whole argument object.
 * @param {string} path For example `$.maxBytes` or `$.input.items[0]`.
 */
export function fieldOf(path) {
  if (path === '$') return 'args';
  return path.replace(/^\$\./, '').replace(/^\$/, 'args');
}

/**
 * @param {object} schema A JSON schema for the argument object.
 * @param {unknown} rawArgs What the model sent.
 * @returns {{ ok: true, args: Record<string, unknown>, fields: [] } | { ok: false, args: null, fields: Array<{ field: string, message: string }> }}
 */
export function checkToolArgs(schema, rawArgs) {
  if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    const got = rawArgs === null ? 'null' : Array.isArray(rawArgs) ? 'array' : typeof rawArgs;
    return { ok: false, args: null, fields: [{ field: 'args', message: `must be an object, got ${got}` }] };
  }
  const args = rawArgs ?? {};
  const strict = schema?.type === 'object' && schema.additionalProperties === undefined ? { ...schema, additionalProperties: false } : schema;
  const errors = validate(args, strict);
  if (errors.length === 0) return { ok: true, args, fields: [] };
  const fields = errors.slice(0, MAX_FIELD_ERRORS).map((line) => {
    const cut = line.indexOf(': ');
    const path = cut === -1 ? '$' : line.slice(0, cut);
    const message = cut === -1 ? line : line.slice(cut + 2);
    return { field: fieldOf(path), message };
  });
  return { ok: false, args: null, fields };
}

/** One line that names each bad field. */
export function describeFields(fields) {
  return fields.map((f) => `${f.field}: ${f.message}`).join('; ');
}

export default { checkToolArgs, describeFields, fieldOf };
