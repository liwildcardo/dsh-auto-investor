/** 美股产品契约：整股、T+1 结算、无涨跌停、纽约时段（含夏令时）。 */
import { fetchQuotes } from '../../core/quotes.js';

const WATCH = [
  { symbol: 'usAAPL', name: 'Apple' },
  { symbol: 'usMSFT', name: 'Microsoft' },
  { symbol: 'usNVDA', name: 'NVIDIA' },
  { symbol: 'usGOOGL', name: 'Alphabet' },
  { symbol: 'usAMZN', name: 'Amazon' },
  { symbol: 'usTSLA', name: 'Tesla' },
];

export default {
  id: 'us',
  name: '美股',
  order: 60,
  currency: 'USD',
  timezone: 'America/New_York',
  capital: { initialRmb: 100000, maxExposureRmb: 100000 },

  market: {
    kind: 'multi',
    fx: 'USDCNY',
    async quote(fetchFn, cfg = {}) {
      const list = (cfg.watchlist ?? WATCH).map(w => w.symbol);
      const quotes = await fetchQuotes(fetchFn, list);
      return { ts: Date.now(), currency: 'USD', quotes };
    },
  },

  universe: {
    watchlist: (cfg = {}) => cfg.watchlist ?? WATCH,
    lotSize: 1,
  },

  news: {
    feeds: [
      { name: 'CNBC财经', kind: 'rss', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    ],
    queries: ['US stock market today', 'Federal Reserve rate decision stocks', '美股 财报 科技股'],
    relevance: {
      core: ['美股', '股票', 'S&P', 'Nasdaq', 'earnings', 'Fed'],
      context: ['rate', 'inflation', 'jobs', 'treasury', 'recession', 'AI'],
    },
    perSymbol: true,
  },

  strategy: {
    barInterval: '1h', // Tencent has no US daily history; session-hour bars from live ticks
    signals: [
      // Session-hour bars accumulate ~6.5/day: lookbacks must fit ~13 bars
      // available in the first days (health reflection shrinks them further
      // if data lags), not the 50-bar originals sized for daily data.
      { id: 'trend', params: { fast: 5, slow: 10 }, weight: 1.2 },
      { id: 'momentum', params: { period: 8, threshold: 0.02 }, weight: 1 },
      { id: 'rsi', params: { period: 9 }, weight: 0.6 },
      { id: 'valuation', params: { low: 0.3, high: 0.8 }, weight: 0.6 },
    ],
    prompt: {
      role: '你是美股投资策略引擎，负责模拟组合的选股与仓位决策。',
      heuristics: [
        '美股由流动性与盈利预期驱动，关注美联储路径与财报季',
        '长牛慢熊，趋势跟随优于逆势抄底；回撤需快速止损',
        '美元走强通常压制风险资产与海外收入占比高的公司',
      ],
      constraints: ['单笔 ≤$2000', '单标的 ≤25%', '仅常规时段 9:30–16:00（纽约）'],
    },
    decision: { actions: ['buy', 'sell', 'hold'], shape: 'symbol+shares' },
    evolvable: [
      { path: 'signals.trend.params.slow', min: 5, max: 60, step: 1 },
      { path: 'signals.trend.params.fast', min: 2, max: 30, step: 1 },
      { path: 'signals.momentum.params.period', min: 5, max: 20, step: 1 },
      { path: 'signals.rsi.params.period', min: 5, max: 20, step: 1 },
      { path: 'signals.momentum.params.threshold', min: 0.01, max: 0.15, step: 0.01 },
      { path: 'risk.stopLossPct', min: -15, max: -2, step: 0.5 },
      { path: 'risk.takeProfitPct', min: 3, max: 40, step: 1 },
      { path: 'signals.valuation.weight', min: 0, max: 2, step: 0.1 },
    ],
  },

  rules: {
    unit: 'share',
    lotSize: 1,
    settlement: 'T+1',
    allowSameDaySell: true, // 美股允许日内交易，T+1 只影响资金结算
    fees: { commissionRate: 0, commissionMin: 0 },
    priceLimit: null,
    sessions: [[570, 960]],
    holidays: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  },

  risk: {
    perTrade: 2000,
    perSymbolPct: 25,
    minVolatility: 0.001, // hourly σ floor
    trailingStopPct: 3,
    maxHoldHours: 120,
    dailyLossPct: -2.5,
    stopLossPct: -6,
    takeProfitPct: 12,
  },
};
