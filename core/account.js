/**
 * 多标的账户记账：本币现金 + 按标的持仓（分批次锁定结算时间）+ 已实现盈亏。
 * 黄金的克重记账是它的特例（unit='gram' 时 qty 即克数）。
 */

export function createAccount({ currency = 'CNY', initial = 100000 } = {}) {
  return { currency, cash: initial, initial, positions: {}, realizedPnl: 0, invested: 0 };
}

export function positionOf(account, symbol) {
  return account.positions[symbol] ?? null;
}

/** Sum of the position's lots. */
export function qtyOf(pos) {
  return (pos?.lots ?? []).reduce((a, l) => a + (l.qty ?? 0), 0);
}

/** Recompute the aggregate fields from lots (call after any lot mutation). */
function settlePos(pos) {
  const qty = qtyOf(pos);
  const cost = (pos.lots ?? []).reduce((a, l) => a + l.qty * l.cost, 0);
  pos.qty = qty;
  pos.costAvg = qty > 0 ? cost / qty : 0;
  pos.earliestSellTs = (pos.lots ?? []).reduce((a, l) => Math.min(a, l.earliestSellTs ?? 0), Infinity);
  if (!Number.isFinite(pos.earliestSellTs)) pos.earliestSellTs = 0;
  return pos;
}

/**
 * Apply a buy fill; returns the position after the fill.
 * The buy fee is folded into the lot cost so holding P&L is net of costs.
 */
export function applyBuy(account, { symbol, qty, price, fee = 0, ts = 0, earliestSellTs = 0 }) {
  if (!(qty > 0) || !(price > 0)) throw new Error('buy needs positive qty and price');
  const cost = qty * price + fee;
  if (cost > account.cash + 1e-9) throw new Error('insufficient cash');
  const pos = account.positions[symbol] ?? { qty: 0, costAvg: 0, earliestSellTs: 0, lots: [] };
  pos.lots ??= [];
  pos.lots.push({ qty, cost: (qty * price + fee) / qty, earliestSellTs: earliestSellTs || ts });
  settlePos(pos);
  account.positions[symbol] = pos;
  account.cash -= cost;
  account.invested += qty * price;
  return pos;
}

/**
 * Apply a sell fill, consuming settled lots first (FIFO). Returns
 * {pos, realized, proceeds}. Unsettled lots cannot be sold.
 */
export function applySell(account, { symbol, qty, price, fee = 0, ts = 0 }) {
  const pos = account.positions[symbol];
  if (!pos || qtyOf(pos) <= 0) throw new Error('no position to sell');
  if (qty > qtyOf(pos) + 1e-9) throw new Error('sell exceeds position');
  const settled = (pos.lots ?? []).filter(l => (l.earliestSellTs ?? 0) <= ts);
  const settledQty = settled.reduce((a, l) => a + l.qty, 0);
  if (qty > settledQty + 1e-9) throw new Error('settlement not reached');

  let remaining = qty;
  let costBasis = 0;
  for (const lot of pos.lots) {
    if (remaining <= 0) break;
    if ((lot.earliestSellTs ?? 0) > ts) continue;
    const take = Math.min(lot.qty, remaining);
    costBasis += take * lot.cost;
    lot.qty -= take;
    remaining -= take;
  }
  pos.lots = pos.lots.filter(l => l.qty > 1e-9);
  if (pos.lots.length === 0) delete account.positions[symbol];
  else settlePos(pos);

  const proceeds = qty * price;
  const realized = proceeds - costBasis - fee;
  account.cash += proceeds - fee;
  account.realizedPnl += realized;
  return { pos: account.positions[symbol] ?? null, realized, proceeds };
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

/** Mark-to-market snapshot. `priceOf(symbol)` returns the latest price or null. */
export function snapshotOf(account, priceOf, dayOpenPriceOf = null) {
  const symbols = Object.keys(account.positions);
  const rows = symbols.map((symbol) => {
    const p = account.positions[symbol];
    const qty = qtyOf(p);
    const price = priceOf(symbol);
    const value = price == null ? qty * p.costAvg : qty * price;
    const pnl = price == null ? 0 : (price - p.costAvg) * qty;
    const open = dayOpenPriceOf?.(symbol) ?? null;
    const today = price != null && open != null ? (price - open) * qty : 0;
    return { symbol, qty, costAvg: p.costAvg, price, value, pnl, today };
  });
  const positionsValue = sum(rows, r => r.value);
  const holdingPnl = sum(rows, r => r.pnl);
  const todayPnl = sum(rows, r => r.today);
  return {
    currency: account.currency,
    cash: account.cash,
    positions: rows,
    positionsValue,
    totalValue: account.cash + positionsValue,
    invested: account.invested,
    realizedPnl: account.realizedPnl,
    holdingPnl,
    todayPnl,
    totalPnl: account.realizedPnl + holdingPnl,
  };
}
