/**
 * @file A small, dependency-free schema validator — enough of JSON Schema's
 * vocabulary to type-check state files, tool arguments, and the dashboard
 * contract, without a 2 MB dependency for a public repo whose whole premise
 * is zero maintenance. Supported keywords: `type` (string | number |
 * integer | boolean | object | array | null, or an array of those), `enum`,
 * `const`, `required`, `properties`, `additionalProperties` (boolean or a
 * schema), `items`, `minItems`, `maxItems`, `minLength`, `maxLength`,
 * `pattern`, `minimum`, `maximum`, `nullable`, `anyOf`, `format` (`date-time`
 * only). Anything else is ignored, never a false negative.
 *
 * Errors are collected (not thrown) with a JSON-pointer-ish path so a
 * corrupt state file or a bad tool call can be reported precisely.
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @param {string[]} [errors]
 * @returns {string[]} Empty when valid.
 */
export function validate(value, schema, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.nullable && value === null) return errors;

  if (schema.anyOf) {
    const ok = schema.anyOf.some((sub) => validate(value, sub, path, []).length === 0);
    if (!ok) errors.push(`${path}: matches none of the allowed shapes`);
    return errors;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected the constant ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPE_CHECKS[t]?.(value))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${describe(value)}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: "${String(value).slice(0, 40)}" is not one of ${schema.enum.join(', ')}`);
    return errors;
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && !ISO_DATE.test(value)) errors.push(`${path}: not an ISO 8601 date-time`);
  }

  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  }

  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validate(value[key], sub, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: unexpected property`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) validate(v, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }

  return errors;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function check(value, schema) {
  const errors = validate(value, schema);
  return { ok: errors.length === 0, errors };
}

export default { validate, check };
