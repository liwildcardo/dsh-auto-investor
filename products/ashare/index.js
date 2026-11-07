/** A股产品契约：100股整数倍、T+1、佣金/印花税/过户费、±10% 涨跌停。 */
import { fetchQuotes } from '../../core/quotes.js';

const WATCH = [
  { symbol: 'sh600519', name: '贵州茅台' },
  { symbol: 'sh600036', name: '招商银行' },
  { symbol: 'sz300750', name: '宁德时代' },
  { symbol: 'sh601318', name: '中国平安' },
  { symbol: 'sz002594', name: '比亚迪' },
  { symbol: 'sh600900', name: '长江电力' },
  { symbol: 'sh601899', name: '紫金矿业' },
  { symbol: 'sh600276', name: '恒瑞医药' },
];

export default {
  id: 'ashare',
  name: 'A股',
  order: 50,
  currency: 'CNY',
  timezone: 'Asia/Shanghai',
  capital: { initialRmb: 100000, maxExposureRmb: 100000 },

  market: {
    kind: 'multi',
    fx: null,
    async quote(fetchFn, cfg = {}) {
      const list = (cfg.watchlist ?? WATCH).map(w => w.symbol);
      const quotes = await fetchQuotes(fetchFn, list);
      return { ts: Date.now(), currency: 'CNY', quotes };
    },
  },

  universe: {
    watchlist: (cfg = {}) => cfg.watchlist ?? WATCH,
    lotSize: 100,
  },

  news: {
    feeds: [
      { name: '中新网财经', kind: 'rss', url: 'https://www.chinanews.com.cn/rss/finance.xml' },
      { name: '东方财富快讯', kind: 'html', url: 'https://finance.eastmoney.com/', linkPattern: 'href="(https://finance\\.eastmoney\\.com/a/\\d+\\.html)"[^>]*>([^<]{8,80})</a>', dateFromUrl: /\/a\/(\d{8})/ },
    ],
    queries: ['A股 行情 走势', '证监会 政策 股市', '上市公司 业绩 财报'],
    relevance: {
      core: ['A股', '股票', '证券', '上市公司', '业绩', '财报', '分红', '回购'],
      context: ['成交额', '资金', '降准', '降息', '政策', '监管', '涨跌'],
    },
    perSymbol: true,
  },

  strategy: {
    indicators: [
      { id: 'ma', params: { period: 20 } },
      { id: 'rsi', params: { period: 14 } },
      { id: 'volume', params: { period: 20 } },
      { id: 'volatility', params: { window: 60 } },
    ],
    signals: [
      { id: 'trend', params: { fast: 5, slow: 20 }, weight: 1.2 },
      { id: 'momentum', params: { period: 10, threshold: 0.03 }, weight: 1 },
      { id: 'rsi', params: { period: 14 }, weight: 0.6 },
      { id: 'volume', params: { period: 20, hot: 1.5 }, weight: 0.8 },
      { id: 'valuation', params: { low: 0.3, high: 0.8 }, weight: 0.6 },
    ],
    prompt: {
      role: '你是A股投资策略引擎，负责模拟组合的选股与仓位决策。',
      heuristics: [
        'A股散户主导、情绪波动大，趋势与量能优先于估值',
        '关注政策（降准降息/产业政策）、业绩预告与北向资金',
        'T+1 制度下避免追高，留足次日止损空间',
      ],
      constraints: ['单笔 ≤1 万元', '单标的 ≤25% 仓位', '总敞口 ≤10 万元', '仅交易时段 9:30–11:30 / 13:00–15:00'],
    },
    decision: { actions: ['buy', 'sell', 'hold'], shape: 'symbol+shares' },
    evolvable: [
      { path: 'signals.trend.params.slow', min: 10, max: 120, step: 5 },
      { path: 'signals.momentum.params.threshold', min: 0.01, max: 0.1, step: 0.005 },
      { path: 'signals.volume.params.hot', min: 1.2, max: 3, step: 0.1 },
      { path: 'signals.valuation.params.low', min: 0.1, max: 0.5, step: 0.05 },
      { path: 'risk.stopLossPct', min: -12, max: -1, step: 0.5 },
      { path: 'risk.takeProfitPct', min: 2, max: 30, step: 0.5 },
    ],
  },

  rules: {
    unit: 'share',
    lotSize: 100,
    settlement: 'T+1',
    fees: { commissionRate: 0.00025, commissionMin: 5, stampDutyRate: 0.0005, transferFeeRate: 0.00001 },
    priceLimit: 10,
    boardLimitPct: 10,
    // 创业板(sz30)/科创板(sh68) 为 ±20%，主板 ±10%
    limitFor: (symbol) => (/^(sz30|sh68)/.test(String(symbol)) ? 20 : 10),
    sessions: [[570, 690], [780, 900]],
    holidays: ['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
  },

  risk: {
    perTrade: 10000,
    perSymbolPct: 25,
    dailyLossPct: -2.5,
    stopLossPct: -5,
    takeProfitPct: 10,
  },
};
