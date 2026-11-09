/**
 * 宏观/基本面因子数据层（批次 E，换源版）：
 *  - 实际收益率：东方财富 `171.UI10Y`（美国10年期通胀国债收益率，JSON，
 *    f43÷1000 为百分比；FRED 在宿主进程内实测 28–30s socket 挂起、web 服务
 *    拒收 application/csv，故弃用——诊断记录见 spec §9）
 *  - 美元指数：er-api 汇率按 DXY 标准公式合成，逐日累积历史
 *  - 全部带 staleness 缓存（26h 重抓门限），失败沿用旧缓存并记录错误
 * 派生输出统一为 {value, asOf, delta5d, stale}：delta 为 5 日变化
 * （收益率类=百分点差，指数类=%变化），asOf 超过 5 天 → stale=true。
 */

const DAY = 86_400_000;
const MAX_AGE = 26 * 3600_000; // daily series republish within ~26h

/** Parse the eastmoney quote payload → {value, asOf, name} or null. */
export function parseEmQuote(json, now = () => Date.now()) {
  const d = json?.data;
  const raw = Number(d?.f43);
  if (!Number.isFinite(raw)) return null;
  const value = raw / 10000; // eastmoney bond yields are quoted ×10000 (26190 → 2.6190%)
  const ts = Number(d?.f86) * 1000;
  const asOf = Number.isFinite(ts) && ts > 0
    ? new Date(ts + 8 * 3600_000).toISOString().slice(0, 10) // Shanghai date
    : new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
  return { value, asOf, name: d?.f58 ? String(d.f58) : null };
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
  return {
    realYield: withDelta(db.getState('factor:em:UI10Y'), now, 'pp'),
    usdIndex: withDelta(db.getState('factor:usdIndex'), now, 'pct'),
  };
}

/**
 * Fetch an eastmoney quote and accumulate daily history (60 obs) behind the
 * 26h gate; failures keep the cache and record the error for observability
 * (fetchedAt: 0 → the next cycle retries instead of waiting 26h).
 */
async function getEmFactor(fetchFn, db, { key, secid }, now) {
  const cached = db.getState(key);
  if (cached && now() - (cached.fetchedAt ?? 0) < MAX_AGE) return cached;
  const started = Date.now();
  try {
    const res = await fetchFn(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f60,f86,f58`,
      { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } },
    );
    if (!res.ok) throw new Error(`em http ${res.status}`);
    const parsed = parseEmQuote(await res.json(), now);
    if (!parsed) throw new Error('em quote parse failed');
    const values = [...(cached?.values ?? [])];
    const lastDate = values[values.length - 1]?.date;
    if (lastDate === parsed.asOf) values[values.length - 1] = { date: parsed.asOf, value: parsed.value };
    else values.push({ date: parsed.asOf, value: parsed.value });
    const entry = { values: values.slice(-60), value: parsed.value, asOf: parsed.asOf, fetchedAt: now() };
    db.putState(key, entry);
    return entry;
  } catch (e) {
    const entry = {
      values: cached?.values ?? [],
      asOf: cached?.asOf ?? null,
      fetchedAt: 0,
      error: String(e?.message ?? e).slice(0, 160),
      errorMs: Date.now() - started,
      errorAt: new Date(started).toISOString(),
    };
    try { db.putState(key, entry); } catch { /* best effort */ }
    return cached ?? entry;
  }
}

/** DXY with daily-accumulated history (60 obs) and the same 26h gate. */
async function getUsdIndex(fetchFn, db, now) {
  const key = 'factor:usdIndex';
  const cached = db.getState(key);
  if (cached && now() - (cached.fetchedAt ?? 0) < MAX_AGE) return cached;
  const started = Date.now();
  try {
    const res = await fetchFn('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(30_000),
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
  } catch (e) {
    const entry = {
      values: cached?.values ?? [],
      asOf: cached?.asOf ?? null,
      fetchedAt: 0,
      error: String(e?.message ?? e).slice(0, 160),
      errorMs: Date.now() - started,
      errorAt: new Date(started).toISOString(),
    };
    try { db.putState(key, entry); } catch { /* best effort */ }
    return cached ?? entry;
  }
}

/**
 * Collect all macro factors for one cycle (network, staleness-gated).
 * Returns {realYield, usdIndex} each {value, asOf, delta5d, stale}|null.
 */
export async function collectFactors(fetchFn, db, now = () => Date.now()) {
  const [ry, usd] = await Promise.all([
    getEmFactor(fetchFn, db, { key: 'factor:em:UI10Y', secid: '171.UI10Y' }, now).catch(() => null),
    getUsdIndex(fetchFn, db, now).catch(() => null),
  ]);
  return {
    realYield: withDelta(ry, now, 'pp'),
    usdIndex: withDelta(usd, now, 'pct'),
  };
}

/** PE(TTM) from a Tencent quote field array (field 39, verified on 4 markets). */
export function peFromQuote(fields) {
  const pe = Number(fields?.[39]);
  return Number.isFinite(pe) && pe > 0 ? pe : null;
}
