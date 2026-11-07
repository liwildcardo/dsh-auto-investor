/**
 * 多标的账户记账：本币现金 + 按标的持仓 + 已实现盈亏。
 * 黄金的克重记账是它的特例（unit='gram' 时 qty 即克数）。
 */

export function createAccount({ currency = 'CNY', initial = 100000 } = {}) {
  return { currency, cash: initial, initial, positions: {}, realizedPnl: 0, invested: 0 };
}

export function positionOf(account, symbol) {
  return account.positions[symbol] ?? null;
}

/** Apply a buy fill; returns the position after the fill. */
export function applyBuy(account, { symbol, qty, price, fee = 0, ts = 0, earliestSellTs = 0 }) {
  if (!(qty > 0) || !(price > 0)) throw new Error('buy needs positive qty and price');
  const cost = qty * price + fee;
  if (cost > account.cash + 1e-9) throw new Error('insufficient cash');
  const pos = account.positions[symbol] ?? { qty: 0, costAvg: 0, earliestSellTs: 0 };
  const newQty = pos.qty + qty;
  pos.costAvg = newQty > 0 ? (pos.costAvg * pos.qty + qty * price) / newQty : 0;
  pos.qty = newQty;
  pos.earliestSellTs = Math.max(pos.earliestSellTs ?? 0, earliestSellTs || ts);
  account.positions[symbol] = pos;
  account.cash -= cost;
  account.invested += qty * price;
  return pos;
}

/** Apply a sell fill; returns {pos, realized, proceeds}. */
export function applySell(account, { symbol, qty, price, fee = 0, ts = 0 }) {
  const pos = account.positions[symbol];
  if (!pos || pos.qty <= 0) throw new Error('no position to sell');
  if (qty > pos.qty + 1e-9) throw new Error('sell exceeds position');
  if ((pos.earliestSellTs ?? 0) > ts) throw new Error('settlement not reached');
  const proceeds = qty * price;
  const realized = (price - pos.costAvg) * qty - fee;
  pos.qty = Math.round((pos.qty - qty) * 1e9) / 1e9;
  if (pos.qty <= 0) delete account.positions[symbol];
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
    const price = priceOf(symbol);
    const value = price == null ? p.qty * p.costAvg : p.qty * price;
    const pnl = price == null ? 0 : (price - p.costAvg) * p.qty;
    const open = dayOpenPriceOf?.(symbol) ?? null;
    const today = price != null && open != null ? (price - open) * p.qty : 0;
    return { symbol, qty: p.qty, costAvg: p.costAvg, price, value, pnl, today };
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
