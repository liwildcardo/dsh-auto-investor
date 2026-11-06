/**
 * Portfolio accounting for the 招行黄金账户 simulation.
 *
 * Screenshot-verified formulas:
 *   持仓金额 = 卖出价 × 持仓克重
 *   持仓收益 = (卖出价 − 成本均价) × 持仓克重
 *   今日收益 = Δ卖出价 × 持仓克重
 *   累计收益 = 已实现盈亏 + 未实现盈亏
 */

export function createPortfolio(capitalCny) {
  return {
    cash: capitalCny,
    grams: 0, // demand (活期) grams
    termGrams: 0, // term (定期) grams
    costAvg: 0,
    realizedPnl: 0,
    investedRmb: 0, // cumulative invested principal (cap: totalLimitRmb)
  };
}

/** Buy `rmb` worth at `buyPrice` (元/克). Caller enforces limits/window. */
export function buy(p, rmb, buyPrice) {
  const grams = rmb / buyPrice;
  const newGrams = p.grams + grams;
  p.costAvg = newGrams === 0 ? 0 : (p.costAvg * p.grams + rmb) / newGrams;
  p.grams = newGrams;
  p.cash -= rmb;
  p.investedRmb += rmb;
  return grams;
}

/** Sell `grams` at `sellPrice`; returns proceeds and books realized PnL. */
export function sell(p, grams, sellPrice) {
  const g = Math.min(grams, p.grams + p.termGrams);
  const fromDemand = Math.min(g, p.grams);
  p.grams -= fromDemand;
  p.termGrams -= g - fromDemand;
  const proceeds = g * sellPrice;
  p.realizedPnl += (sellPrice - p.costAvg) * g;
  p.cash += proceeds;
  return proceeds;
}

/** Move demand grams into the term (定期) bucket. */
export function toTerm(p, grams) {
  const g = Math.min(grams, p.grams);
  p.grams -= g;
  p.termGrams += g;
  return g;
}

/** Move term grams back to demand (活期). */
export function fromTerm(p, grams) {
  const g = Math.min(grams, p.termGrams);
  p.termGrams -= g;
  p.grams += g;
  return g;
}

/** Credit demand-deposit gram yield (克重收益), pro-rated by days. */
export function settleDemandYield(p, annualPct, days) {
  const credited = p.grams * (annualPct / 100) * (days / 365);
  p.grams += credited;
  return credited;
}

/**
 * Point-in-time valuation.
 * @param p portfolio
 * @param quote current quote ({sell, buy}) or null when no price is known
 * @param baseline day-open quote (null when unknown)
 */
export function snapshot(p, quote, baseline) {
  const totalGrams = p.grams + p.termGrams;
  if (!quote) {
    // No price known: value at cost basis and report nothing fabricated.
    return {
      noQuote: true,
      grams: totalGrams,
      demandGrams: p.grams,
      termGrams: p.termGrams,
      costAvg: p.costAvg,
      cash: round2(p.cash),
      marketValue: round2(p.costAvg * totalGrams),
      holdingPnl: 0,
      todayPnl: 0,
      realizedPnl: round2(p.realizedPnl),
      totalPnl: round2(p.realizedPnl),
      investedRmb: round2(p.investedRmb),
    };
  }
  const marketValue = round2(quote.sell * totalGrams);
  const exposure = round2(p.costAvg * totalGrams);
  const holdingPnl = round2((quote.sell - p.costAvg) * totalGrams);
  const todayPnl = baseline ? round2((quote.sell - baseline.sell) * totalGrams) : 0;
  return {
    noQuote: false,
    grams: totalGrams,
    demandGrams: p.grams,
    termGrams: p.termGrams,
    costAvg: p.costAvg,
    cash: round2(p.cash),
    marketValue,
    exposure,
    holdingPnl,
    holdingReturnPct: exposure !== 0 ? round4((holdingPnl / exposure) * 100) : 0,
    todayPnl,
    realizedPnl: round2(p.realizedPnl),
    totalPnl: round2(p.realizedPnl + holdingPnl),
    investedRmb: round2(p.investedRmb),
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}
