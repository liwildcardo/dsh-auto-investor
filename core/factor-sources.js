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
const MAX_AGE_RATIO = 30 * 60_000; // intraday spot ratio: 26h is too blunt

/** Error text incl. the hidden undici cause (ENOTFOUND / ECONNREFUSED / ...). */
function describeError(e) {
  const cause = e?.cause ? ` [${e.cause.code ?? e.cause.message ?? ''}]` : '';
  return `${String(e?.message ?? e)}${cause}`.slice(0, 160);
}

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

/** Parse eastmoney daily klines ("date,open,close") → [{date, value}] (close). */
export function parseEmKlines(klines) {
  return (klines ?? []).map((line) => {
    const parts = String(line).split(',');
    const date = parts[0];
    const value = Number(parts[2]); // close
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) ? { date, value } : null;
  }).filter(Boolean);
}

/** Parse a frankfurter time-series (base USD) → [{date, dxy}] via computeDxy. */
export function parseFrankfurterDxy(json) {
  const out = [];
  for (const [date, rates] of Object.entries(json?.rates ?? {})) {
    const value = computeDxy(rates);
    if (Number.isFinite(value)) out.push({ date, value: Math.round(value * 100) / 100 });
  }
  return out;
}

/** Merge history before current values; current wins on the same date. */
function mergeHistory(history, current) {
  const byDate = new Map();
  for (const p of history ?? []) if (p?.date) byDate.set(p.date, p);
  for (const p of current ?? []) if (p?.date) byDate.set(p.date, p);
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
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
  const realYield = withDelta(db.getState('factor:em:UI10Y'), now, 'pp');
  const usdIndex = withDelta(db.getState('factor:usdIndex'), now, 'pct');
  const us10Y = withDelta(db.getState('factor:em:US10Y'), now, 'pp');
  const us02Y = withDelta(db.getState('factor:em:US02Y'), now, 'pp');
  return {
    realYield,
    usdIndex,
    us10Y,
    us02Y,
    breakeven: deriveSpread(us10Y, realYield, now),
    yieldCurve: deriveSpread(us10Y, us02Y, now),
    goldSilverRatio: withDelta(db.getState('factor:xauXagRatio'), now, 'pct'),
  };
}

/**
 * Pair two daily series into their difference: for every date in `a`, find
 * the newest observation in `b` at-or-older than that date within
 * `maxGapDays` (the two sources publish on different calendars). Returns
 * {values:[{date,value:a-b}], value, asOf, fetchedAt} or null when nothing
 * pairs — a spread with no anchor is worse than no spread (signals abstain).
 */
export function pairSeries(a, b, maxGapDays = 4) {
  const av = [...(a?.values ?? [])]
    .filter((p) => Number.isFinite(Date.parse(p?.date)) && Number.isFinite(p?.value))
    .sort((x, y) => Date.parse(x.date) - Date.parse(y.date)); // 导出助手不信任输入有序
  const bv = b?.values ?? [];
  if (!av.length || !bv.length) return null;
  const gapMs = maxGapDays * DAY;
  const out = [];
  for (const p of av) {
    const t = Date.parse(p.date);
    let best = null;
    let bestT = -Infinity;
    for (const q of bv) {
      const qt = Date.parse(q?.date);
      if (!Number.isFinite(qt) || !Number.isFinite(q?.value)) continue;
      if (qt > t || t - qt > gapMs) continue;
      if (qt > bestT) { best = q; bestT = qt; }
    }
    if (best) out.push({ date: p.date, value: p.value - best.value });
  }
  if (!out.length) return null;
  const last = out[out.length - 1];
  return {
    values: out,
    value: last.value,
    asOf: last.date,
    fetchedAt: Math.max(a.fetchedAt ?? 0, b.fetchedAt ?? 0),
  };
}

/** Derived spread with delta5d + staleness (either source stale → stale). */
function deriveSpread(a, b, now) {
  if (!a || !b) return null;
  const paired = pairSeries(a, b);
  if (!paired) return null;
  const d = withDelta(paired, now, 'pp');
  if (!d) return null;
  if (a.stale || b.stale) d.stale = true;
  return d;
}

/**
 * XAU/XAG 现货金银比：gold-api 双端点并发，30 分钟抓取门，按上海日期
 * 累积历史（同日覆盖）。失败沿用旧缓存、fetchedAt:0 让下轮立即重试。
 */
async function getGoldSilverRatio(fetchFn, db, now) {
  const key = 'factor:xauXagRatio';
  const cached = db.getState(key);
  const fresh = cached && now() - (cached.fetchedAt ?? 0) < MAX_AGE_RATIO;
  if (fresh) return cached;
  const started = Date.now();
  try {
    const headers = { 'user-agent': 'Mozilla/5.0' };
    const [xauRes, xagRes] = await Promise.all([
      fetchFn('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(8000), headers }),
      fetchFn('https://api.gold-api.com/price/XAG', { signal: AbortSignal.timeout(8000), headers }),
    ]);
    if (!xauRes?.ok || !xagRes?.ok) {
      throw new Error(`gold-api http ${xauRes?.status ?? '?'}/${xagRes?.status ?? '?'}`);
    }
    const xau = Number((await xauRes.json())?.price);
    const xag = Number((await xagRes.json())?.price);
    if (!(xau > 0) || !(xag > 0)) throw new Error('gold-api price missing');
    const date = new Date(now() + 8 * 3600_000).toISOString().slice(0, 10); // Shanghai date
    const ratio = xau / xag;
    const entry = {
      values: mergeHistory(cached?.values ?? [], [{ date, value: ratio }]).slice(-60),
      value: ratio,
      asOf: date,
      fetchedAt: now(),
    };
    db.putState(key, entry);
    return entry;
  } catch (e) {
    const entry = {
      values: cached?.values ?? [],
      value: cached?.value ?? null,
      asOf: cached?.asOf ?? null,
      fetchedAt: 0,
      error: describeError(e),
      errorMs: Date.now() - started,
      errorAt: new Date(started).toISOString(),
    };
    try { db.putState(key, entry); } catch { /* best effort */ }
    return cached ?? entry;
  }
}

/**
 * Fetch an eastmoney quote and accumulate daily history (60 obs) behind the
 * 26h gate; failures keep the cache and record the error for observability
 * (fetchedAt: 0 → the next cycle retries instead of waiting 26h).
 */
async function getEmFactor(fetchFn, db, { key, secid }, now) {
  const cached = db.getState(key);
  const fresh = cached && now() - (cached.fetchedAt ?? 0) < MAX_AGE;
  // Fresh value AND enough history → nothing to do. A fresh value with a
  // thin history still runs the seed below (the 26h gate must not block it).
  if (fresh && (cached.values?.length ?? 0) >= 2) return cached;
  const started = Date.now();
  try {
    let entry;
    if (fresh) {
      entry = { ...cached }; // value is current; only history is missing
    } else {
      const res = await fetchFn(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f60,f86,f58`,
        { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } },
      );
      if (!res.ok) throw new Error(`em http ${res.status}`);
      const parsed = parseEmQuote(await res.json(), now);
      if (!parsed) throw new Error('em quote parse failed');
      entry = {
        values: mergeHistory(cached?.values ?? [], [{ date: parsed.asOf, value: parsed.value }]),
        value: parsed.value,
        asOf: parsed.asOf,
        fetchedAt: now(),
      };
    }
    // Bootstrap: delta5d needs ≥2 points; one-shot best-effort seed from the
    // daily kline (failures retry next cycle — the gate keeps values < 2 open).
    if ((entry.values?.length ?? 0) < 2) {
      try {
        const beg = new Date(now() - 60 * DAY).toISOString().slice(0, 10).replaceAll('-', '');
        const h = await fetchFn(
          `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=101&fqt=0&beg=${beg}&end=20991231`,
          { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' } },
        );
        if (h.ok) {
          entry = { ...entry, values: mergeHistory(parseEmKlines((await h.json())?.data?.klines), entry.values ?? []).slice(-60) };
        }
      } catch { /* seed failure → next cycle retries */ }
    }
    db.putState(key, entry);
    return entry;
  } catch (e) {
    const entry = {
      values: cached?.values ?? [],
      asOf: cached?.asOf ?? null,
      fetchedAt: 0,
      error: describeError(e),
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
  const fresh = cached && now() - (cached.fetchedAt ?? 0) < MAX_AGE;
  if (fresh && (cached.values?.length ?? 0) >= 2) return cached;
  const started = Date.now();
  try {
    let entry;
    if (fresh) {
      entry = { ...cached };
    } else {
      const res = await fetchFn('https://open.er-api.com/v6/latest/USD', {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
      if (!res.ok) throw new Error(`fx http ${res.status}`);
      const json = await res.json();
      const value = computeDxy(json?.rates);
      if (!Number.isFinite(value)) throw new Error('dxy unavailable');
      const asOf = new Date(now() + 8 * 3600_000).toISOString().slice(0, 10); // Shanghai date
      entry = {
        values: mergeHistory(cached?.values ?? [], [{ date: asOf, value }]),
        value,
        asOf,
        fetchedAt: now(),
      };
    }
    // Bootstrap from ECB history (frankfurter, base USD → same per-USD shape)
    // so the 5-day delta works from day one.
    if ((entry.values?.length ?? 0) < 2) {
      try {
        const start = new Date(now() - 60 * DAY).toISOString().slice(0, 10);
        const h = await fetchFn(`https://api.frankfurter.app/${start}..?from=USD`, {
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'Mozilla/5.0' },
        });
        if (h.ok) entry = { ...entry, values: mergeHistory(parseFrankfurterDxy(await h.json()), entry.values ?? []).slice(-60) };
      } catch { /* seed failure → next cycle retries */ }
    }
    db.putState(key, entry);
    return entry;
  } catch (e) {
    const entry = {
      values: cached?.values ?? [],
      asOf: cached?.asOf ?? null,
      fetchedAt: 0,
      error: describeError(e),
      errorMs: Date.now() - started,
      errorAt: new Date(started).toISOString(),
    };
    try { db.putState(key, entry); } catch { /* best effort */ }
    return cached ?? entry;
  }
}

/**
 * Collect all macro factors for one cycle (network, staleness-gated).
 * Returns {realYield, usdIndex, us10Y, us02Y, breakeven, yieldCurve}
 * each {value, asOf, delta5d, stale}|null.
 */
export async function collectFactors(fetchFn, db, now = () => Date.now()) {
  const [ry, usd, u10, u02, gsr] = await Promise.all([
    getEmFactor(fetchFn, db, { key: 'factor:em:UI10Y', secid: '171.UI10Y' }, now).catch(() => null),
    getUsdIndex(fetchFn, db, now).catch(() => null),
    getEmFactor(fetchFn, db, { key: 'factor:em:US10Y', secid: '171.US10Y' }, now).catch(() => null),
    getEmFactor(fetchFn, db, { key: 'factor:em:US02Y', secid: '171.US02Y' }, now).catch(() => null),
    getGoldSilverRatio(fetchFn, db, now).catch(() => null),
  ]);
  const realYield = withDelta(ry, now, 'pp');
  const us10Y = withDelta(u10, now, 'pp');
  const us02Y = withDelta(u02, now, 'pp');
  return {
    realYield,
    usdIndex: withDelta(usd, now, 'pct'),
    us10Y,
    us02Y,
    breakeven: deriveSpread(us10Y, realYield, now),
    yieldCurve: deriveSpread(us10Y, us02Y, now),
    goldSilverRatio: withDelta(gsr, now, 'pct'),
  };
}

/** PE(TTM) from a Tencent quote field array (field 39, verified on 4 markets). */
export function peFromQuote(fields) {
  const pe = Number(fields?.[39]);
  return Number.isFinite(pe) && pe > 0 ? pe : null;
}
