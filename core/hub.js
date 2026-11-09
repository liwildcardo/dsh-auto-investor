/**
 * 多产品聚合层：把每个产品的引擎包装成带 product 维度的统一接口，
 * 供路由与 Agent 工具调用。单产品形态（旧测试）仍直接传 service。
 */
import { searchSymbols } from './quotes.js';

export function createHub({ engines, products, fetchFn = undefined }) {
  const byId = new Map(engines.map(e => [e.id, e]));
  // A typo'd product id must fail loudly instead of silently using another
  // product's account (agent tools and routes both rely on this).
  const pick = (pid) => {
    if (pid == null || pid === '') return engines[0];
    const e = byId.get(pid);
    if (!e) throw new Error(`unknown product: ${pid}`);
    return e;
  };
  const pids = () => engines.map(e => e.id);

  return {
    products: () => products.map(p => ({ id: p.id, name: p.name, currency: p.currency, order: p.order })),
    product: (pid) => {
      const p = products.find(x => x.id === (pid ?? pids()[0]));
      return p ? { id: p.id, name: p.name, currency: p.currency, display: p.display ?? null } : null;
    },
    status: (pid, symbol) => pick(pid).status(symbol),
    runCycle: (pid) => pick(pid).runCycle(),
    reflectIfDue: (pid, opts = {}) => pick(pid).reflectIfDue(opts),
    pause: (pid, v) => pick(pid).pause(v),
    newsList: (pid, limit) => {
      const e = pick(pid);
      return typeof e.listNews === 'function' ? e.listNews(limit) : [];
    },
    trades: (pid, limit = 20) => pick(pid).status().trades.slice(0, limit),
    versions: (pid) => pick(pid).status().versions,
    watchlist: (pid) => pick(pid).watchlist(),
    watchlistAction: (pid, body) => pick(pid).watchlistAction(body),
    backtest: (pid, symbol) => pick(pid).runBacktest(symbol),
    search: async (pid, q) => {
      if (typeof fetchFn !== 'function') return [];
      const product = products.find(x => x.id === (pid ?? pids()[0])) ?? products[0];
      return searchSymbols(fetchFn, q, product?.id);
    },
    tickAll: () => Promise.all(engines.map(e => e.tick().catch(() => null))),
  };
}
