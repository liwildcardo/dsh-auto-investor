/**
 * 产品契约：校验并归一化一个投资产品定义。
 * 引擎只消费归一化后的契约，不包含任何产品专有常量。
 */

const DEFAULTS = {
  order: 100,
  capital: { initialRmb: 100000, maxExposureRmb: 100000 },
  market: { kind: 'multi', fx: null },
  universe: { watchlist: () => [], lotSize: 1 },
  news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: true },
  strategy: {
    indicators: [],
    signals: [],
    candidates: null,
    prompt: {},
    decision: { actions: ['buy', 'sell', 'hold'], shape: 'symbol+shares' },
    evolvable: [],
    // Default frequency plan: the engine falls back to this whenever a version
    // has no plan (forks before plan-preservation existed, migrations).
    plan: { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 4, maxPositionPct: 60 },
  },
  rules: {
    unit: 'share',
    lotSize: 1,
    settlement: 'T+0',
    fees: {},
    priceLimit: null,
    sessions: [[0, 1440]],
    holidays: [],
    boardLimitPct: null,
    // Hard frequency caps: bound ANY version plan (max = min(plan, hard),
    // gap = max(plan, hardMin)) so a lost/permissive plan can never loosen them.
    hardMaxTradesPerDay: 3,
    hardMinIntervalHours: 2,
  },
  risk: {
    perTrade: 5000, // native currency amount
    perSymbolPct: 100,
    dailyLossPct: -2,
    circuitBreakerPct: -15, // total drawdown from the initial capital stops new trades
    stopLossPct: -3,
    takeProfitPct: 6,
  },
};

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function merge(base, extra) {
  if (!isObj(base) || !isObj(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** Structural validation. Returns every problem so a bad product fails loudly. */
export function validateProduct(p) {
  const errors = [];
  if (!isObj(p)) return { ok: false, errors: ['product must be an object'] };
  for (const key of ['id', 'name', 'currency', 'timezone', 'market', 'universe', 'news', 'strategy', 'rules', 'risk']) {
    if (p[key] == null) errors.push(`missing ${key}`);
  }
  if (p.id != null && !/^[a-z][a-z0-9-]*$/.test(String(p.id))) errors.push('id must be lowercase kebab-case');
  if (p.market != null && typeof p.market.quote !== 'function') errors.push('market.quote must be a function');
  if (p.universe != null && typeof p.universe.watchlist !== 'function') errors.push('universe.watchlist must be a function');
  if (p.rules != null && !Array.isArray(p.rules.sessions)) errors.push('rules.sessions must be an array of [startMin, endMin]');
  if (p.strategy != null && p.strategy.signals != null && !Array.isArray(p.strategy.signals)) errors.push('strategy.signals must be an array');
  return { ok: errors.length === 0, errors };
}

/** Merge defaults (deep) and validate. Throws on an invalid contract. */
export function normalizeProduct(raw) {
  const check = validateProduct(raw);
  if (!check.ok) throw new Error(`invalid product: ${check.errors.join('; ')}`);
  const merged = merge(DEFAULTS, raw);
  return {
    ...merged,
    // Arrays are product state, never shared with the defaults object.
    rules: { ...merged.rules, sessions: merged.rules.sessions.map(s => [...s]), holidays: [...(merged.rules.holidays ?? [])] },
    news: { ...merged.news, feeds: [...(merged.news.feeds ?? [])], queries: [...(merged.news.queries ?? [])] },
    strategy: { ...merged.strategy, indicators: [...merged.strategy.indicators], signals: [...merged.strategy.signals] },
  };
}
