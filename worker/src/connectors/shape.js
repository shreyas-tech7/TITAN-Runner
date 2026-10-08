/**
 * @file Pure helpers that shape a connector answer (Wave 12, C1): keep the listed fields, and cap the size.
 */

export const MAX_RESULT_BYTES = 32_000;

/**
 * Keep only the listed paths. A path like `user.login` follows objects. A path like `labels[].name` maps over an array.
 * A root array is mapped item by item. A root object with a `results`, `items`, or `data` array is mapped too.
 */
export function pick(data, paths) {
  if (!paths || paths.length === 0) return data;
  if (Array.isArray(data)) return data.map((item) => pick(item, paths));
  if (data && typeof data === 'object') {
    const wrap = ['results', 'items', 'data', 'issues', 'values'].find((k) => Array.isArray(data[k]) && !paths.some((p) => p.split('.')[0].replace('[]', '') === k));
    if (wrap && paths.every((p) => !(p.split('.')[0].replace('[]', '') in data))) return { [wrap]: data[wrap].map((item) => pick(item, paths)) };
  }
  const out = {};
  for (const path of paths) {
    const parts = path.split('.');
    pickInto(data, parts, out);
  }
  return out;
}

function pickInto(src, parts, dst) {
  if (src === null || src === undefined || typeof src !== 'object') return;
  const [head, ...rest] = parts;
  const many = head.endsWith('[]');
  const key = many ? head.slice(0, -2) : head;
  if (!(key in src)) return;
  const value = src[key];
  if (rest.length === 0) {
    dst[key] = value;
    return;
  }
  if (many) {
    if (!Array.isArray(value)) return;
    if (!Array.isArray(dst[key])) dst[key] = value.map(() => ({}));
    value.forEach((item, i) => pickInto(item, rest, dst[key][i]));
  } else {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      if (!Array.isArray(dst[key])) dst[key] = value.map(() => ({}));
      value.forEach((item, i) => pickInto(item, rest, dst[key][i]));
    } else {
      if (typeof dst[key] !== 'object' || dst[key] === null) dst[key] = {};
      pickInto(value, rest, dst[key]);
    }
  }
}

/** Cap the size of a result. Long arrays and long strings are cut, and the flag tells the caller. */
export function capSize(value, maxBytes = MAX_RESULT_BYTES) {
  let text = JSON.stringify(value);
  if (text === undefined || text.length <= maxBytes) return { value, truncated: false };
  let v = JSON.parse(text);
  const shrink = (node, limit) => {
    if (typeof node === 'string') return node.length > limit ? `${node.slice(0, limit)}...` : node;
    if (Array.isArray(node)) return node.slice(0, 25).map((n) => shrink(n, limit));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, n]) => [k, shrink(n, limit)]));
    return node;
  };
  for (const limit of [500, 200, 80]) {
    v = shrink(v, limit);
    text = JSON.stringify(v);
    if (text.length <= maxBytes) return { value: v, truncated: true };
  }
  return { value: { note: 'The result was too large to return.' }, truncated: true };
}

