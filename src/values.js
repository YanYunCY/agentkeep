// Small helpers for reading, writing and comparing parsed settings.

export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

export function isEmpty(v) {
  return v === undefined || v === null || v === ''
    || (Array.isArray(v) && v.length === 0)
    || (isObj(v) && Object.keys(v).length === 0);
}

export function get(obj, path) {
  let o = obj;
  for (const k of path) {
    if (!isObj(o) || !Object.hasOwn(o, k)) return undefined;
    o = o[k];
  }
  return o;
}

export function has(obj, path) {
  const parent = get(obj, path.slice(0, -1));
  return isObj(parent) && Object.hasOwn(parent, path.at(-1));
}

export function set(obj, path, value) {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k];
  }
  o[path.at(-1)] = value;
}

// JSON with object keys sorted, so two values compare equal regardless of
// key order. Dates arrive here already turned into ISO strings by toJSON.
export function canon(v) {
  return JSON.stringify(v, (_, x) =>
    isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
}

export function equal(a, b) {
  return canon(a) === canon(b);
}

export function nest(path, value) {
  const out = {};
  set(out, path, value);
  return out;
}

export function pathLabel(path) {
  return path.map((k, i) => (/^[A-Za-z0-9_-]+$/.test(k) ? (i ? '.' : '') + k : `[${JSON.stringify(k)}]`)).join('');
}
