/**
 * 宏观/基本面因子数据层（批次 E）：
 *  - FRED CSV 系列（实际收益率 DFII10、通胀预期 T10YIE），无需密钥
 *  - 美元指数 DXY：er-api 汇率按标准公式合成，逐日累积历史
 *  - 全部带 staleness 缓存（26h 重抓门限），失败沿用旧缓存
 * 派生输出统一为 {value, asOf, delta5d, stale}：delta 为 5 日变化
 * （收益率类=百分点差，指数类=%变化），asOf 超过 5 天 → stale=true。
 */

const DAY = 86_400_000;
const FRED_MAX_AGE = 26 * 3600_000; // daily series republish within ~26h

/** Parse `observation_date,VALUE` CSV (skip '.' missing values). */
export function parseFredCsv(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n').slice(1)) {
    const idx = line.indexOf(',');
    if (idx <= 0) continue;
    const date = line.slice(0, idx).trim();
    const value = Number(line.slice(idx + 1).trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)) continue; // '.' etc.
    out.push({ date, value });
  }
  return out;
}

/** DXY standard formula from USD-base FX rates (er-api shape). */
export function computeDxy(rates) {
  const { EUR, JPY, GBP, CAD, SEK, CHF } = rates ?? {};
  const vals = [EUR, JPY, GBP, CAD, SEK, CHF];
  if (!vals.every(r => Number.isFinite(r) && r > 0)) return null;
  const eurUsd = 1 / EUR; // er-api gives EUR per USD
  const gbpUsd = 1 / GBP;
  return 50.14348112
    * Math.pow(eurUsd, 0.576)
    * Math.pow(JPY, 0.136)
    * Math.pow(gbpUsd, 0.119)
    * Math.pow(CAD, 0.091)
    * Math.pow(SEK, 0.042)
    * Math.pow(CHF, 0.036);
}

/** Derive delta5d + staleness from a cached factor entry. */
function withDelta(entry, now, kind) {
  if (!entry) return null;
  const asOfMs = Date.parse(entry.asOf);
  const stale = Number.isFinite(asOfMs) ? now() - asOfMs > 5 * DAY : false;
  const values = entry.values ?? [];
  let delta5d = null;
  if (values.length >= 2) {
    const last = values[values.length - 1];
    const target = Date.parse(last.date) - 5 * DAY;
    let ref = values[0]; // nearest observation at/older than 5 days back
    for (const p of values) {
      if (Date.parse(p.date) <= target) ref = p; else break;
    }
    delta5d = kind === 'pct'
      ? ((last.value - ref.value) / ref.value) * 100
      : last.value - ref.value;
    delta5d = Math.round(delta5d * 10000) / 10000;
  }
  const value = entry.value ?? (values.length ? values[values.length - 1].value : null);
  return { ...entry, value, delta5d, stale };
}

/** Read cached factors (no network) — used by status/prompt. */
export function readFactors(db, now = () => Date.now()) {
  const fred = (id, kind) => withDelta(db.getState(`factor:fred:${id}`), now, kind);
  return {
    realYield: fred('DFII10', 'pp'),
    inflationExp: fred('T10YIE', 'pp'),
    usdIndex: withDelta(db.getState('factor:usdIndex'), now, 'pct'),
  };
}

/** Fetch one FRED series with a 26h cache; failures fall back to the cache. */
async function getFredSeries(fetchFn, db, id, now) {
  const key = `factor:fred:${id}`;
  const cached = db.getState(key);
  if (cached && now() - (cached.fetchedAt ?? 0) < FRED_MAX_AGE) return cached;
  try {
    const res = await fetchFn(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new Error(`fred http ${res.status}`);
    const values = parseFredCsv(await res.text()).slice(-60);
    if (!values.length) throw new Error('empty fred series');
    const entry = { values, asOf: values[values.length - 1].date, fetchedAt: now() };
    db.putState(key, entry);
    return entry;
  } catch {
    return cached ?? null; // degrade: last known values, else factor unavailable
  }
}

/** DXY with daily-accumulated history (60 obs) and the same 26h gate. */
async function getUsdIndex(fetchFn, db, now) {
  const key = 'factor:usdIndex';
  const cached = db.getState(key);
  if (cached && now() - (cached.fetchedAt ?? 0) < FRED_MAX_AGE) return cached;
  try {
    const res = await fetchFn('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new Error(`fx http ${res.status}`);
    const json = await res.json();
    const value = computeDxy(json?.rates);
    if (!Number.isFinite(value)) throw new Error('dxy unavailable');
    const asOf = new Date(now() + 8 * 3600_000).toISOString().slice(0, 10); // Shanghai date
    const values = [...(cached?.values ?? [])];
    const lastDate = values[values.length - 1]?.date;
    if (lastDate === asOf) values[values.length - 1] = { date: asOf, value };
    else values.push({ date: asOf, value });
    const entry = { values: values.slice(-60), value, asOf, fetchedAt: now() };
    db.putState(key, entry);
    return entry;
  } catch {
    return cached ?? null;
  }
}

/**
 * Collect all macro factors for one cycle (network, staleness-gated).
 * Returns {realYield, inflationExp, usdIndex} each {value, asOf, delta5d, stale}|null.
 */
export async function collectFactors(fetchFn, db, now = () => Date.now()) {
  const [ry, ie, usd] = await Promise.all([
    getFredSeries(fetchFn, db, 'DFII10', now).catch(() => null),
    getFredSeries(fetchFn, db, 'T10YIE', now).catch(() => null),
    getUsdIndex(fetchFn, db, now).catch(() => null),
  ]);
  return {
    realYield: withDelta(ry, now, 'pp'),
    inflationExp: withDelta(ie, now, 'pp'),
    usdIndex: withDelta(usd, now, 'pct'),
  };
}

/** PE(TTM) from a Tencent quote field array (field 39, verified on 4 markets). */
export function peFromQuote(fields) {
  const pe = Number(fields?.[39]);
  return Number.isFinite(pe) && pe > 0 ? pe : null;
}
