/** 港股产品契约：按手交易、T+2 结算、双边印花税、香港时段。 */
import { fetchQuotes } from '../../core/quotes.js';

const WATCH = [
  { symbol: 'hk00700', name: '腾讯控股', lot: 100 },
  { symbol: 'hk09988', name: '阿里巴巴', lot: 100 },
  { symbol: 'hk03690', name: '美团', lot: 100 },
  { symbol: 'hk00941', name: '中国移动', lot: 500 },
  { symbol: 'hk02318', name: '中国平安', lot: 500 },
  { symbol: 'hk01810', name: '小米集团', lot: 200 },
];

export default {
  id: 'hk',
  name: '港股',
  order: 70,
  currency: 'HKD',
  timezone: 'Asia/Hong_Kong',
  capital: { initialRmb: 100000, maxExposureRmb: 100000 },

  market: {
    kind: 'multi',
    fx: 'HKDCNY',
    async quote(fetchFn, cfg = {}) {
      const list = (cfg.watchlist ?? WATCH).map(w => w.symbol);
      const quotes = await fetchQuotes(fetchFn, list);
      return { ts: Date.now(), currency: 'HKD', quotes };
    },
  },

  universe: {
    watchlist: (cfg = {}) => cfg.watchlist ?? WATCH,
    lotSize: 100,
  },

  news: {
    feeds: [
      { name: '新浪港股', kind: 'html', url: 'https://finance.sina.com.cn/stock/hkstock/', linkPattern: 'href="(https://finance\\.sina\\.com\\.cn/stock/hkstock/[^"]+\\.shtml)"[^>]*>([^<]{8,80})</a>' },
      { name: '中新网财经', kind: 'rss', url: 'https://www.chinanews.com.cn/rss/finance.xml' },
      { name: 'CNBC财经', kind: 'rss', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    ],
    queries: ['港股 恒生指数 走势', '南向资金 港股', '香港 上市公司 业绩'],
    relevance: {
      core: ['港股', '恒生', '港交所', '南向资金', '业绩'],
      context: ['内地', '政策', '美元', '流动性', '估值'],
    },
    perSymbol: true,
  },

  strategy: {
    barInterval: '1d',
    signals: [
      { id: 'trend', params: { fast: 5, slow: 20 }, weight: 1.2 },
      { id: 'momentum', params: { period: 10, threshold: 0.035 }, weight: 1 },
      { id: 'rsi', params: { period: 14 }, weight: 0.6 },
    ],
    prompt: {
      role: '你是港股投资策略引擎，负责模拟组合的选股与仓位决策。',
      heuristics: [
        '港股受内地政策与美元流动性双重驱动，估值区间波动明显',
        '关注南向资金、人民币汇率与中概股情绪',
        'T+2 结算，注意资金占用与持仓周转',
      ],
      constraints: ['单笔 ≤HK$15000', '单标的 ≤25%', '仅交易时段 9:30–12:00 / 13:00–16:00（香港）'],
    },
    decision: { actions: ['buy', 'sell', 'hold'], shape: 'symbol+shares' },
    evolvable: [
      { path: 'signals.trend.params.slow', min: 10, max: 120, step: 5 },
      { path: 'signals.momentum.params.threshold', min: 0.01, max: 0.1, step: 0.005 },
      { path: 'risk.stopLossPct', min: -15, max: -2, step: 0.5 },
      { path: 'risk.takeProfitPct', min: 3, max: 40, step: 1 },
    ],
  },

  rules: {
    unit: 'share',
    lotSize: 100,
    settlement: 'T+2',
    allowSameDaySell: true, // 港股允许日内交易，T+2 只影响资金结算
    fees: {
      commissionRate: 0.0025, commissionMin: 100,
      stampDutyRate: 0.001, stampDutyBothSides: true,
      tradingFeeRate: 0.0000565, settlementFeeRate: 0.00002,
    },
    priceLimit: null,
    // 港股每手股数因标的而异（自选池中声明）
    lotSizeFor: (symbol) => (WATCH.find(w => w.symbol === symbol)?.lot ?? 100),
    sessions: [[570, 720], [780, 960]],
    holidays: ['2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-25', '2026-06-19', '2026-07-01', '2026-09-26', '2026-10-01', '2026-10-19', '2026-12-25'],
  },

  risk: {
    perTrade: 15000,
    perSymbolPct: 25,
    minVolatility: 0.006, // daily σ floor
    trailingStopPct: 3,
    maxHoldHours: 120,
    dailyLossPct: -2.5,
    stopLossPct: -6,
    takeProfitPct: 12,
  },
};
