/**
 * 产品注册表：内置产品 + 配置启停。引擎按注册顺序创建账户与页面。
 */
import gold from '../products/gold/index.js';
import ashare from '../products/ashare/index.js';
import us from '../products/us/index.js';
import hk from '../products/hk/index.js';
import { normalizeProduct } from './product.js';

export const BUILTIN = [gold, ashare, us, hk];

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge an override into a product (arrays/functions replace wholesale). */
export function mergeProduct(base, extra) {
  if (!isObj(base) || !isObj(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isObj(v) && isObj(base[k]) ? mergeProduct(base[k], v) : v;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string[]} [opts.enabled]  enabled product ids (default: all builtins)
 * @param {object} [opts.overrides]  per-product config overrides { [id]: patch }
 * @returns normalized products in page order
 */
export function loadProducts(opts = {}) {
  const enabled = opts.enabled ?? BUILTIN.map(p => p.id);
  const overrides = opts.overrides ?? {};
  return BUILTIN
    .filter(p => enabled.includes(p.id))
    .map(p => normalizeProduct(overrides[p.id] ? mergeProduct(p, overrides[p.id]) : p))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
