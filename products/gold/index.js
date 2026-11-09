/** 黄金产品契约：克重记账、招行规则、现有资讯源与信号配置。 */
import { DEFAULT_FEEDS } from '../../lib/news.js';
import { quoteFrom, parseGoldApi, parseFxApi } from '../../lib/market.js';

const gramsPerOunce = 31.1035;

export default {
  id: 'gold',
  name: '黄金',
  order: 40,
  currency: 'CNY',
  timezone: 'Asia/Shanghai',
  capital: { initialRmb: 100000, maxExposureRmb: 100000 },

  market: {
    kind: 'single',
    fx: 'USDCNY',
    async quote(fetchFn, cfg = {}) {
      const [goldRes, fxRes] = await Promise.all([
        fetchFn('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(8000) }),
        fetchFn('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) }),
      ]);
      const xau = parseGoldApi(await goldRes.json());
      const usdCny = parseFxApi(await fxRes.json());
      if (!xau || !usdCny) throw new Error('gold quote unavailable');
      const q = quoteFrom(xau, usdCny, cfg.spreadCnyPerGram ?? 5, cfg.gramsPerOunce ?? gramsPerOunce);
      return { price: q.mid, buy: q.buy, sell: q.sell, ts: Date.now(), currency: 'CNY' };
    },
  },

  universe: {
    watchlist: () => [{ symbol: 'AU9999', name: '黄金', lot: 1 }],
    lotSize: 1,
  },

  news: {
    feeds: DEFAULT_FEEDS,
    queries: ['央行增持黄金', '伦敦金 黄金价格 走势', '美联储 利率 黄金'],
    relevanceMode: 'gold',
    relevance: {
      core: ['黄金', '金价', '贵金属', '央行购金'],
      context: ['美联储', '利率', '通胀', '地缘', '美元'],
    },
    perSymbol: false,
  },

  strategy: {
    barInterval: '1h', // no daily history source; hourly session bars from live ticks
    signals: [
      { id: 'trend', params: { fast: 5, slow: 20 }, weight: 1.2 },
      { id: 'momentum', params: { period: 10, threshold: 0.02 }, weight: 1 },
      { id: 'rsi', params: { period: 14 }, weight: 0.6 },
      { id: 'realYield', weight: 0.8 },
      { id: 'usdIndex', weight: 0.6 },
    ],
    prompt: {
      role: '你是黄金投资策略引擎，负责招行黄金账户的模拟投资决策。',
      heuristics: ['黄金波动率低、趋势性强，避免高频交易', '关注实际利率、美元指数与央行购金'],
      constraints: ['单笔 ≤5000 元', '总敞口 ≤10 万元', '仅交易时段 9:10–次日02:00'],
    },
    decision: { actions: ['buy', 'sell', 'hold'], shape: 'rmb' },
    evolvable: [
      { path: 'signals.trend.params.slow', min: 10, max: 120, step: 5 },
      { path: 'signals.trend.params.fast', min: 3, max: 20, step: 1 },
      { path: 'signals.momentum.params.period', min: 5, max: 30, step: 1 },
      { path: 'signals.trend.weight', min: 0.2, max: 3, step: 0.1 },
      { path: 'risk.stopLossPct', min: -12, max: -1, step: 0.5 },
      { path: 'risk.takeProfitPct', min: 1, max: 20, step: 0.5 },
      { path: 'signals.realYield.weight', min: 0, max: 2, step: 0.1 },
      { path: 'signals.usdIndex.weight', min: 0, max: 2, step: 0.1 },
    ],
  },

  rules: {
    unit: 'gram',
    lotSize: 1,
    settlement: 'T+0',
    fees: { spreadCnyPerGram: 5 },
    priceLimit: null,
    sessions: [[550, 1560]],
    holidays: [],
  },

  risk: {
    perTrade: 5000,
    perSymbolPct: 100,
    minVolatility: 0.0004, // hourly σ floor: no entries in dead markets
    trailingStopPct: 1.5, // lock intraday profits (gold is a trend asset; no time stop)
    dailyLossPct: -2,
    stopLossPct: -3,
    takeProfitPct: 6,
  },
};
