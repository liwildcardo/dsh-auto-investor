/**
 * 自选池：按产品持久化可编辑的标的列表（上限 10 只）。
 * 首次读取回退到产品默认池；之后完全由持久化状态驱动。
 */
const MAX_WATCHLIST = 10;

const MARKET_PREFIX = {
  ashare: /^(sh|sz)\d{6}$/,
  us: /^us[A-Za-z.]{1,10}$/,
  hk: /^hk\d{5}$/,
};

/** Market rule for one product; gold's AU9999 is exempt from prefix checks. */
function validateSymbol(productId, symbol) {
  const re = MARKET_PREFIX[productId];
  if (!re) return true; // unknown/custom products accept any symbol
  return re.test(String(symbol ?? ''));
}

function defaultWatchlist(product) {
  return (product.universe.watchlist(product) ?? []).map(w => ({
    symbol: w.symbol,
    name: w.name,
    ...(w.lot ? { lot: w.lot } : {}),
  }));
}

/** Current pool (persisted, else product defaults). Never mutates storage. */
export function loadWatchlist(db, product) {
  const key = `product:${product.id}:watchlist`;
  const saved = db.getState(key);
  if (Array.isArray(saved) && saved.length) return saved;
  return defaultWatchlist(product);
}

/** Replace the persisted pool (used by add/remove/reset). */
function saveWatchlist(db, product, list) {
  db.putState(`product:${product.id}:watchlist`, list.slice(0, MAX_WATCHLIST));
}

/**
 * Add one symbol. Rejects duplicates, market violations and pool overflow.
 * @returns {{ok: boolean, error?: string, watchlist: Array}}
 */
export function addToWatchlist(db, product, symbol, name = '') {
  const list = loadWatchlist(db, product);
  const sym = String(symbol ?? '').trim();
  if (!sym) return { ok: false, error: '标的代码不能为空', watchlist: list };
  if (!validateSymbol(product.id, sym)) {
    return { ok: false, error: `代码格式不符（${product.name}）`, watchlist: list };
  }
  if (list.some(w => w.symbol === sym)) {
    return { ok: false, error: '该标的已在自选池中', watchlist: list };
  }
  if (list.length >= MAX_WATCHLIST) {
    return { ok: false, error: `自选池已满（上限 ${MAX_WATCHLIST} 只）`, watchlist: list };
  }
  const entry = { symbol: sym, name: String(name ?? '').trim() };
  // Inherit the lot size from the product default when known (HK per-symbol lots).
  const def = defaultWatchlist(product).find(w => w.symbol === sym);
  if (def?.lot) entry.lot = def.lot;
  const next = [...list, entry];
  saveWatchlist(db, product, next);
  return { ok: true, watchlist: next };
}

/** Remove one symbol; refuses to empty the pool (the engine needs a target). */
export function removeFromWatchlist(db, product, symbol) {
  const list = loadWatchlist(db, product);
  const next = list.filter(w => w.symbol !== symbol);
  if (next.length === list.length) return { ok: false, error: '标的不在自选池中', watchlist: list };
  if (next.length === 0) return { ok: false, error: '自选池不能为空', watchlist: list };
  saveWatchlist(db, product, next);
  return { ok: true, watchlist: next };
}

/** Restore the product's built-in defaults. */
export function resetWatchlist(db, product) {
  const list = defaultWatchlist(product);
  saveWatchlist(db, product, list);
  return { ok: true, watchlist: list };
}

export const WATCHLIST_LIMIT = MAX_WATCHLIST;
