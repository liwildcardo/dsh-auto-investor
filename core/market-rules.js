/**
 * 市场规则：费用、手数、结算、交易时段、涨跌停。所有函数只读产品 rules，
 * 不绑定任何具体市场，由产品参数驱动。
 */

/** Wall-clock parts in a product's market timezone (handles US DST correctly). */
// Intl formatters are expensive to build — cache one per time zone.
const FORMATTERS = new Map();

export function zonedParts(ts, timeZone) {
  let fmt = FORMATTERS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
    });
    FORMATTERS.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(hour), minute: Number(p.minute), second: Number(p.second ?? 0),
    weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(hour) * 60 + Number(p.minute),
  };
}

const isWeekend = (weekday) => weekday === 'Sat' || weekday === 'Sun';

/**
 * Epoch for a wall-clock time in a market timezone (handles DST): converges
 * on the offset whose local parts match the requested date/time.
 */
export function zonedEpoch(year, month, day, hour, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let ts = target;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(ts, timeZone);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = wall - target;
    if (diff === 0) break;
    ts -= diff;
  }
  return ts;
}

/** Session check with wrap-around support (endMin may exceed 1440, e.g. gold 1560). */
export function isSessionOpen(rules, ts, timeZone) {
  const z = zonedParts(ts, timeZone);
  if (isWeekend(z.weekday)) return false;
  if ((rules.holidays ?? []).includes(z.date)) return false;
  const minutes = z.minutes;
  for (const [start, end] of rules.sessions ?? []) {
    if (end <= 1440) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end - 1440) {
      // Session crosses midnight: the pre-midnight part belongs to the previous
      // weekday's session, so a weekend only blocks the post-midnight leg.
      if (minutes >= start) return true;
      const prev = zonedParts(ts - 86_400_000, timeZone);
      if (!isWeekend(prev.weekday) && !(rules.holidays ?? []).includes(prev.date)) return true;
    }
  }
  return false;
}

/** Floor a quantity to the product's lot size (per-symbol override honoured). */
export function roundLot(rules, qty, symbol = null) {
  if (rules.unit === 'gram') return Math.floor(qty * 1000) / 1000;
  const perSymbol = symbol != null && typeof rules.lotSizeFor === 'function' ? rules.lotSizeFor(symbol) : null;
  const lot = Math.max(1, Math.floor(perSymbol ?? rules.lotSize ?? 1));
  return Math.floor(qty / lot) * lot;
}

/** Transaction costs for one side. Rates come from the product's rules. */
export function tradeFees(rules, side, notional) {
  const f = rules.fees ?? {};
  const commission = f.commissionRate != null
    ? Math.max(notional * f.commissionRate, f.commissionMin ?? 0)
    : 0;
  const stampDuty = (side === 'sell' || f.stampDutyBothSides) ? notional * (f.stampDutyRate ?? 0) : 0;
  const transferFee = notional * (f.transferFeeRate ?? 0);
  const regulator = notional * ((f.tradingFeeRate ?? 0) + (f.settlementFeeRate ?? 0));
  const total = commission + stampDuty + transferFee + regulator;
  return { commission, stampDuty, transferFee, regulator, total };
}

/**
 * Settlement unlock: the first session start of the next trading day (T+1) or
 * two trading days out (T+2), skipping weekends/holidays.
 */
export function earliestSellTs(buyTs, rules, timeZone) {
  // US/HK settlement (T+1/T+2) governs cash settlement, not whether you may
  // sell: day trading is allowed there. Only markets with a real sell lock
  // (A-share T+1) delay the sell side.
  if (rules.allowSameDaySell) return buyTs;
  const delay = rules.settlement === 'T+2' ? 2 : rules.settlement === 'T+1' ? 1 : 0;
  if (delay === 0) return buyTs;
  const startMin = rules.sessions?.[0]?.[0] ?? 0;
  let remaining = delay;
  let ts = buyTs;
  for (let guard = 0; guard < 10; guard += 1) {
    ts += 86_400_000;
    const z = zonedParts(ts, timeZone);
    if (isWeekend(z.weekday) || (rules.holidays ?? []).includes(z.date)) continue;
    remaining -= 1;
    if (remaining === 0) return ts + (startMin - z.minutes) * 60_000;
  }
  return ts;
}

/** Price band for limit-up/limit-down products; null when unconstrained. */
export function priceLimitBand(rules, prevClose, symbol = null) {
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;
  const perSymbol = symbol != null && typeof rules.limitFor === 'function' ? rules.limitFor(symbol) : null;
  const pct = perSymbol ?? rules.boardLimitPct ?? rules.priceLimit;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return { up: prevClose * (1 + pct / 100), down: prevClose * (1 - pct / 100) };
}

/** Whether a fill price is inside the allowed band (null band = always true). */
export function withinPriceBand(rules, prevClose, price, symbol = null) {
  const band = priceLimitBand(rules, prevClose, symbol);
  if (!band) return true;
  return price <= band.up + 1e-9 && price >= band.down - 1e-9;
}
