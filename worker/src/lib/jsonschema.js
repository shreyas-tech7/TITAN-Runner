/**
 * @file A small JSON Schema validator for connector actions (Wave 12, C1 and C3). It covers the keywords that action
 * inputs and manifests use, and nothing else, so it stays short and has no dependency.
 *
 * Supported: type, enum, const, required, properties, additionalProperties, items, minItems, maxItems, minLength,
 * maxLength, pattern, minimum, maximum, anyOf, oneOf, and default (through `withDefaults`). A keyword that this file does
 * not know is ignored, but `$ref` is an error, because a silent skip would let bad input through.
 *
 * Strict mode, which is the default: an object may hold only the properties that the schema lists, unless the schema
 * says `additionalProperties: true`. This is the rule "reject unknown fields".
 */

const MAX_DEPTH = 10;

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(want, value) {
  const got = typeOf(value);
  if (want === got) return true;
  if (want === 'number' && got === 'integer') return true;
  return false;
}

/**
 * @param {any} schema
 * @param {any} value
 * @param {{ strict?: boolean }} [opts]
 * @returns {string[]} A list of problems. The list is empty when the value is valid.
 */
export function validate(schema, value, opts = {}) {
  const errors = [];
  walk(schema, value, '$', errors, 0, opts.strict !== false);
  return errors;
}

function walk(schema, value, path, errors, depth, strict) {
  if (depth > MAX_DEPTH) {
    errors.push(`${path}: the schema is nested too deep`);
    return;
  }
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: no value is allowed here`);
    return;
  }
  if (typeof schema !== 'object' || schema === null) return;
  if (schema.$ref) {
    errors.push(`${path}: $ref is not supported`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected ${types.join(' or ')} but got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined) {
      let ok = false;
      try {
        ok = new RegExp(schema.pattern).test(value);
      } catch {
        errors.push(`${path}: the pattern in the schema is not valid`);
        ok = true;
      }
      if (!ok) errors.push(`${path}: does not match the pattern ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: must have at most ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors, depth + 1, strict));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const name of schema.required ?? []) if (!(name in value)) errors.push(`${path}.${name}: is required`);
    for (const [name, v] of Object.entries(value)) {
      if (name in props) walk(props[name], v, `${path}.${name}`, errors, depth + 1, strict);
      else if (schema.additionalProperties === false || (strict && schema.additionalProperties !== true && typeof schema.additionalProperties !== 'object')) {
        errors.push(`${path}.${name}: is not a known field`);
      } else if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties, v, `${path}.${name}`, errors, depth + 1, strict);
    }
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => {
      const e = [];
      walk(s, value, path, e, depth + 1, strict);
      return e;
    });
    if (!results.some((e) => e.length === 0)) errors.push(`${path}: matches none of the allowed shapes`);
  }
  if (schema.oneOf) {
    const count = schema.oneOf.filter((s) => {
      const e = [];
      walk(s, value, path, e, depth + 1, strict);
      return e.length === 0;
    }).length;
    if (count !== 1) errors.push(`${path}: must match exactly one of the allowed shapes`);
  }
}

/** Fill in `default` values for missing properties. It returns a new object. */
export function withDefaults(schema, value) {
  if (!schema || typeof schema !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    if (!(name in out) && spec && typeof spec === 'object' && 'default' in spec) out[name] = spec.default;
    else if (name in out && spec?.type === 'object') out[name] = withDefaults(spec, out[name]);
  }
  return out;
}
