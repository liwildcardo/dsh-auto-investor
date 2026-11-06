/**
 * Lossless-JSON normalization for tool-facing payloads.
 *
 * node:sqlite rows carry a null prototype and raw values can contain -0,
 * NaN, or undefined leaves — all rejected by the harness's lossless-JSON
 * check ("value is not lossless JSON"). Every tool output passes through
 * jsonSafe() so it round-trips JSON.parse(JSON.stringify(x)) unchanged.
 */

export function jsonSafe(value) {
  return normalize(value, new WeakSet());
}

function normalize(value, seen) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : (Number.isFinite(value) ? 0 : null);
  if (t === 'bigint') return Number.isFinite(Number(value)) ? Number(value) : null;
  if (t === 'undefined') return undefined;
  if (t === 'function' || t === 'symbol') return null;
  // objects
  if (seen.has(value)) return null; // break cycles instead of throwing
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      return value.map(v => {
        const n = normalize(v, seen);
        return n === undefined ? null : n;
      });
    }
    const out = {};
    for (const key of Object.keys(value)) {
      const n = normalize(value[key], seen);
      if (n !== undefined) out[key] = n;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
