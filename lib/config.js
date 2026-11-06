/** Default configuration + merge with the patch-row config. */

const DEFAULTS = {
  // Safety limits (RMB)
  perTradeLimitRmb: 5000,
  totalLimitRmb: 100000,
  initialCapitalRmb: 100000,

  // 招行黄金账户 quote model (screenshot-verified)
  spreadCnyPerGram: 5.0, // 买入价 = mid + spread/2, 卖出价 = mid − spread/2
  gramsPerOunce: 31.1035,

  // Product rules (screenshot-verified)
  minTradeGrams: 1,
  minTradeRmb: 1200,
  toTermMinGrams: 10,
  // Trading window in minutes-of-day, Asia/Shanghai. 9:10 -> 26:00 (= next day 02:00)
  tradingWindow: { startMin: 9 * 60 + 10, endMin: 26 * 60 },
  holidays: [], // 'YYYY-MM-DD' strings, non-trading days beyond weekends

  // Demand-deposit gram yield; settled quarterly on the 21st of Mar/Jun/Sep/Dec
  demandYieldAnnualPct: 0.35,
  termYieldAnnualPct: 1.2,

  // Physical redemption premium above sell price (元/克)
  physicalPremiumCnyPerGram: 15,

  // Trade-frequency discipline (gold is a low-turnover asset).
  // Hard caps bound ANY strategy plan; the plan itself is part of the strategy.
  hardMaxTradesPerDay: 3,
  hardMinIntervalHours: 2,
  defaultPlan: {
    style: 'swing',
    maxTradesPerDay: 2,
    minIntervalHours: 4,
    maxPositionPct: 60,
    stopLossPct: -3,
    takeProfitPct: 6,
  },

  // Risk controls (global, cannot be loosened by any strategy).
  hardStopLossPct: -5, // force liquidation when holding return ≤ this
  takeProfitFraction: 0.5, // fraction sold on take-profit
  minConfidence: 0.4, // LLM decisions below this confidence become hold
  circuitBreakerPct: -15, // pause the engine at this total-return loss
  dailyLossLimitPct: -2, // stop trading for the day at this day-return loss
  quoteMaxAgeSec: 300,

  // Polling intervals
  pricePollSec: 60,
  newsPollMin: 15,
  cycleMin: 30,

  // Reflection loop (learning)
  reflectLossPct: -3, // version return below this triggers reflection
  reflectConsecLosses: 3,
  reflectMaxDrawdownPct: -8,
  reflectIntervalHours: 24, // unconditional periodic review cadence
  stableMinTrades: 5,
  stableMaxDrawdownPct: -5,
  stableMinReturnPct: 0,

  // News
  newsLimit: 20,
  newsMaxAgeDays: 60, // drop items older than this at ingest
};

export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw };
  if (raw.tradingWindow) cfg.tradingWindow = { ...DEFAULTS.tradingWindow, ...raw.tradingWindow };
  if (raw.defaultPlan) cfg.defaultPlan = { ...DEFAULTS.defaultPlan, ...raw.defaultPlan };
  return cfg;
}

export { DEFAULTS };
