/**
 * @deprecated 单产品时代的招行规则校验。多市场规则见 core/market-rules.js；此文件仅供旧测试与历史参考。
 */
/**
 * 招行黄金账户 trading rules (screenshot-verified), pure functions.
 *
 * - 交易时间: 交易日 9:10 – 次日凌晨 2:00 (Asia/Shanghai); 交易日 = 周一至周五 − 假期.
 * - 交易起点: 1克 / 1200元起.
 * - 单笔 ≤ perTradeLimitRmb (5000); 累计投资 ≤ totalLimitRmb (100000).
 * - 定活互转: 活期转入定期 10克起.
 */

const SHANGHAI_OFFSET_MIN = 8 * 60;
const HOUR_MS = 3600_000;

const MARKET_SIDES = new Set(['buy', 'sell']); // conversions don't consume trade quota

/**
 * Trade-frequency gate: gold is low-turnover; a plan caps trades per trading
 * day and the minimum interval between market trades. Plans are clamped by
 * the global hard caps before enforcement.
 */
export function checkFrequency(trades, plan, nowTs, cfg = {}) {
  const hardMax = cfg.hardMaxTradesPerDay ?? 3;
  const hardMinH = cfg.hardMinIntervalHours ?? 2;
  const maxPerDay = Math.min(Number(plan?.maxTradesPerDay) || hardMax, hardMax);
  const minH = Math.max(Number(plan?.minIntervalHours) || hardMinH, hardMinH);

  const market = (trades ?? []).filter(t => MARKET_SIDES.has(t.side) && Number.isFinite(t.ts));
  const session = sessionDate(nowTs, cfg);
  const sessionCount = market.filter(t => sessionDate(t.ts, cfg) === session).length;
  if (sessionCount >= maxPerDay) {
    return { ok: false, reason: `交易频率超限：每交易日最多 ${maxPerDay} 笔 (maxTradesPerDay)` };
  }
  const last = market.reduce((m, t) => (t.ts > (m?.ts ?? -Infinity) ? t : m), undefined);
  if (last && nowTs - last.ts < minH * HOUR_MS) {
    return { ok: false, reason: `交易频率超限：距上次交易不足 ${minH} 小时 (minIntervalHours)` };
  }
  return { ok: true };
}

/**
 * Trading-session date: the 00:00–02:00 continuation belongs to the previous
 * day's session, so a Mon 09:10 + Tue 01:00 pair is one session.
 */
export function sessionDate(ts, cfg) {
  const { minutes } = shanghaiClock(ts);
  const endMin = cfg?.tradingWindow?.endMin ?? 26 * 60;
  const dayShift = minutes < endMin - 24 * 60 ? 24 * 3600_000 : 0;
  return shanghaiClock(ts - dayShift).date;
}

/** Wall-clock minutes-of-day and YYYY-MM-DD in Asia/Shanghai. */
export function shanghaiClock(ts) {
  const t = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  const shifted = t + SHANGHAI_OFFSET_MIN * 60_000;
  const d = new Date(shifted);
  return {
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10),
    weekday: d.getUTCDay(),
  };
}

function isTradingDay(dateStr, weekday, cfg) {
  if (weekday === 0 || weekday === 6) return false;
  return !(cfg.holidays ?? []).includes(dateStr);
}

/**
 * Trading session: 9:10–26:00 where 24:00–26:00 is the early-morning
 * continuation of the previous trading day's session.
 */
export function isTradingTime(date, cfg) {
  const ts = date instanceof Date ? date.getTime() : Number(date);
  const { minutes, date: today, weekday } = shanghaiClock(ts);
  const { startMin, endMin } = cfg.tradingWindow;

  if (minutes >= startMin && minutes < 24 * 60) {
    return isTradingDay(today, weekday, cfg);
  }
  if (minutes < endMin - 24 * 60) {
    // early morning: belongs to the previous day's session
    const prev = shanghaiClock(ts - 24 * 3600_000);
    return isTradingDay(prev.date, prev.weekday, cfg);
  }
  return false;
}

/**
 * Validate one simulated operation against product rules, safety caps, and
 * the strategy's trade-frequency plan.
 * @param op {side: 'buy'|'sell'|'toTerm'|'fromTerm', rmb?, grams?, ts}
 * @param options {plan?: frequency plan, trades?: recent trades}
 * @returns {ok: boolean, reason?: string}
 */
export function validateTrade(op, p, quote, cfg, options = {}) {
  const ts = op.ts ?? Date.now();
  if (!isTradingTime(ts, cfg)) {
    return { ok: false, reason: 'outside trading window (交易时段: 交易日 9:10–次日2:00)' };
  }
  if (MARKET_SIDES.has(op.side)) {
    const quoteAge = options.quoteTs !== undefined ? ts - options.quoteTs : 0;
    const maxAgeMs = (cfg.quoteMaxAgeSec ?? 300) * 1000;
    if (options.quoteTs !== undefined && quoteAge > maxAgeMs) {
      return { ok: false, reason: `行情数据陈旧（${Math.round(quoteAge / 1000)}s > ${cfg.quoteMaxAgeSec ?? 300}s），拒绝成交` };
    }
    const freq = checkFrequency(options.trades, options.plan, ts, cfg);
    if (!freq.ok) return freq;
  }

  switch (op.side) {
    case 'buy': {
      const rmb = Number(op.rmb);
      if (!Number.isFinite(rmb) || rmb <= 0) return { ok: false, reason: 'invalid amount' };
      if (rmb > cfg.perTradeLimitRmb) return { ok: false, reason: `单笔投资不得超过 ${cfg.perTradeLimitRmb} 元` };
      if (p.investedRmb + rmb > cfg.totalLimitRmb) return { ok: false, reason: `投资总额不得超过 ${cfg.totalLimitRmb} 元` };
      if (rmb < cfg.minTradeRmb) return { ok: false, reason: `交易起点 ${cfg.minTradeRmb} 元 / ${cfg.minTradeGrams} 克起` };
      const grams = rmb / quote.buy;
      if (grams < cfg.minTradeGrams) return { ok: false, reason: `交易起点 ${cfg.minTradeGrams} 克起` };
      if (rmb > p.cash) return { ok: false, reason: '可用资金不足' };
      // Position sizing: current exposure + this trade must stay within the plan.
      const planPct = options.plan?.maxPositionPct ?? cfg.defaultPlan?.maxPositionPct ?? 100;
      const capital = cfg.initialCapitalRmb ?? cfg.totalLimitRmb;
      const exposure = p.costAvg * (p.grams + p.termGrams);
      if (exposure + rmb > capital * (planPct / 100)) {
        return { ok: false, reason: `超过最大仓位 ${planPct}%（当前敞口 ${Math.round(exposure)} 元）` };
      }
      return { ok: true };
    }
    case 'sell': {
      const grams = Number(op.grams);
      if (!Number.isFinite(grams) || grams <= 0) return { ok: false, reason: 'invalid grams' };
      const holdings = p.grams + p.termGrams;
      if (holdings <= 0) return { ok: false, reason: '无可用持仓 (no holdings)' };
      if (grams > holdings) return { ok: false, reason: '卖出克重超过持仓' };
      return { ok: true };
    }
    case 'toTerm': {
      const grams = Number(op.grams);
      if (!Number.isFinite(grams) || grams <= 0) return { ok: false, reason: 'invalid grams' };
      if (grams < cfg.toTermMinGrams) return { ok: false, reason: `活期转入定期 ${cfg.toTermMinGrams} 克起` };
      if (grams > p.grams) return { ok: false, reason: '活期可用克重不足' };
      return { ok: true };
    }
    case 'fromTerm': {
      const grams = Number(op.grams);
      if (!Number.isFinite(grams) || grams <= 0) return { ok: false, reason: 'invalid grams' };
      if (grams > p.termGrams) return { ok: false, reason: '定期可用克重不足' };
      return { ok: true };
    }
    default:
      return { ok: false, reason: `unknown operation: ${op.side}` };
  }
}
