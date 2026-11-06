/**
 * Market data: XAU (USD/oz) + USD/CNY -> 招行黄金账户 quote model.
 *
 * Screenshot-verified: 买入价 = mid + spread/2, 卖出价 = mid − spread/2
 * (851.01 / 846.01 around mid 848.51, spread 5.00 元/克).
 */

/** Quote from raw FX/oz values. mid is 元/克. */
export function quoteFrom(xauUsd, usdCny, spread = 5.0, gramsPerOunce = 31.1035) {
  const mid = (xauUsd * usdCny) / gramsPerOunce;
  return {
    mid: round2(mid),
    buy: round2(mid + spread / 2),
    sell: round2(mid - spread / 2),
    xauUsd,
    usdCny,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Parse https://api.gold-api.com/price/XAU payload -> USD/oz or null. */
export function parseGoldApi(json) {
  if (!json || typeof json !== 'object') return null;
  const p = json.price;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/** Parse https://open.er-api.com/v6/latest/USD payload -> USD->CNY rate or null. */
export function parseFxApi(json) {
  if (!json || typeof json !== 'object') return null;
  const r = json.rates?.CNY;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
}

/** Change of the latest sell price vs the previous tick. */
export function computeChange(ticks) {
  if (!Array.isArray(ticks) || ticks.length < 2) return { delta: 0, pct: 0 };
  const prev = ticks[ticks.length - 2].sell;
  const last = ticks[ticks.length - 1].sell;
  const delta = round4(last - prev);
  const pct = prev !== 0 ? round4((delta / prev) * 100) : 0;
  return { delta, pct };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** Rolling momentum/volatility summary for the strategist prompt. */
export function summarize(ticks, window = 24) {
  const recent = ticks.slice(-window);
  if (recent.length === 0) return null;
  const prices = recent.map(t => t.mid);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const ma = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((a, b) => a + (b - ma) ** 2, 0) / prices.length;
  return {
    count: prices.length,
    first: round2(first),
    last: round2(last),
    high: round2(Math.max(...prices)),
    low: round2(Math.min(...prices)),
    ma: round2(ma),
    volatility: round4(Math.sqrt(variance)),
    changePct: first !== 0 ? round4(((last - first) / first) * 100) : 0,
  };
}

/**
 * Chart geometry with axis ticks: polyline points inside the plot area,
 * Y price labels (元/克), X time labels (HH:MM Asia/Shanghai).
 */
export function chartModel(ticks, width, height, opts = {}) {
  const pad = opts.padding ?? 12;
  const yGutter = opts.yGutter ?? 52; // room for price labels on the left
  const xGutter = opts.xGutter ?? 28; // room for time labels at the bottom
  const plot = {
    x0: yGutter,
    x1: Math.max(yGutter + 1, width - pad),
    y0: pad,
    y1: Math.max(pad + 1, height - xGutter),
  };

  const pts = (ticks ?? []).map(t => ({ ts: t.ts, v: t.mid ?? t.sell }));
  if (pts.length === 0) {
    return { points: [], plot, yAxis: { ticks: [] }, xAxis: { ticks: [] } };
  }

  const values = pts.map(p => p.v);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const n = pts.length;

  const xAt = i => (n === 1 ? (plot.x0 + plot.x1) / 2 : plot.x0 + ((plot.x1 - plot.x0) * i) / (n - 1));
  const yAt = v => plot.y1 - ((v - lo) / span) * (plot.y1 - plot.y0);

  const points = pts.map((p, i) => ({ x: Math.round(xAt(i) * 100) / 100, y: Math.round(yAt(p.v) * 100) / 100 }));

  // Y axis: 4-5 labeled price levels between lo and hi
  const yTickCount = opts.yTicks ?? 5;
  const yTicksArr = [];
  for (let k = 0; k < yTickCount; k++) {
    const v = lo + (span * k) / (yTickCount - 1);
    yTicksArr.push({ y: Math.round(yAt(v) * 100) / 100, label: v.toFixed(2) });
  }

  // X axis: ~4 labeled times from first to last tick (Asia/Shanghai HH:MM)
  const xTickCount = Math.min(opts.xTicks ?? 4, n);
  const xTicksArr = [];
  for (let k = 0; k < xTickCount; k++) {
    const i = xTickCount === 1 ? 0 : Math.round(((n - 1) * k) / (xTickCount - 1));
    xTicksArr.push({ x: Math.round(xAt(i) * 100) / 100, label: shTime(pts[i].ts) });
  }

  return { points, plot, yAxis: { ticks: yTicksArr }, xAxis: { ticks: xTicksArr } };
}

/** HH:MM in Asia/Shanghai (+08:00). */
function shTime(ts) {
  const d = new Date(ts + 8 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
