/**
 * 瀹忚/鍩烘湰闈㈠洜瀛愭暟鎹眰锛堟壒娆?E锛屾崲婧愮増锛夛細
 *  - 瀹為檯鏀剁泭鐜囷細涓滄柟璐㈠瘜 `171.UI10Y`锛堢編鍥?0骞存湡閫氳儉鍥藉€烘敹鐩婄巼锛孞SON锛? *    f43梅1000 涓虹櫨鍒嗘瘮锛汧RED 鍦ㄥ涓昏繘绋嬪唴瀹炴祴 28鈥?0s socket 鎸傝捣銆亀eb 鏈嶅姟
 *    鎷掓敹 application/csv锛屾晠寮冪敤鈥斺€旇瘖鏂褰曡 spec 搂9锛? *  - 缇庡厓鎸囨暟锛歟r-api 姹囩巼鎸?DXY 鏍囧噯鍏紡鍚堟垚锛岄€愭棩绱Н鍘嗗彶
 *  - 鍏ㄩ儴甯?staleness 缂撳瓨锛?6h 閲嶆姄闂ㄩ檺锛夛紝澶辫触娌跨敤鏃х紦瀛樺苟璁板綍閿欒
 * 娲剧敓杈撳嚭缁熶竴涓?{value, asOf, delta5d, stale}锛歞elta 涓?5 鏃ュ彉鍖? * 锛堟敹鐩婄巼绫?鐧惧垎鐐瑰樊锛屾寚鏁扮被=%鍙樺寲锛夛紝asOf 瓒呰繃 5 澶?鈫?stale=true銆? */

const DAY = 86_400_000;
const MAX_AGE = 26 * 3600_000; // daily series republish within ~26h

/** Error text incl. the hidden undici cause (ENOTFOUND / ECONNREFUSED / 鈥?. */
function describeError(e) {
  const cause = e?.cause ? ` [${e.cause.code ?? e.cause.message ?? ''}]` : '';
  return `${String(e?.message ?? e)}${cause}`.slice(0, 160);
}

/** Parse the eastmoney quote payload 鈫?{value, asOf, name} or null. */
export function parseEmQuote(json, now = () => Date.now()) {
  const d = json?.data;
  const raw = Number(d?.f43);
  if (!Number.isFinite(raw)) return null;
  const value = raw / 10000; // eastmoney bond yields are quoted 脳10000 (26190 鈫?2.6190%)
  const ts = Number(d?.f86) * 1000;
  const asOf = Number.isFinite(ts) && ts > 0
    ? new Date(ts + 8 * 3600_000).toISOString().slice(0, 10) // Shanghai date
    : new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
  return { value, asOf, name: d?.f58 ? String(d.f58) : null };
}

/** Parse eastmoney daily klines ("date,open,close") 鈫?[{date, value}] (close). */
export function parseEmKlines(klines) {
  return (klines ?? []).map((line) => {
    const parts = String(line).split(',');
    const date = parts[0];
    const value = Number(parts[2]); // close
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) ? { date, value } : null;
  }).filter(Boolean);
}

/** Parse a frankfurter time-series (base USD) 鈫?[{date, dxy}] via computeDxy. */
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

/** Read cached factors (no network) 鈥?used by status/prompt. */
export function readFactors(db, now = () => Date.now()) {
  return {
    realYield: withDelta(db.getState('factor:em:UI10Y'), now, 'pp'),
    usdIndex: withDelta(db.getState('factor:usdIndex'), now, 'pct'),
  };
}

/**
 * Fetch an eastmoney quote and accumulate daily history (60 obs) behind the
 * 26h gate; failures keep the cache and record the error for observability
 * (fetchedAt: 0 鈫?the next cycle retries instead of waiting 26h).
 */
async function getEmFactor(fetchFn, db, { key, secid }, now) {
  const cached = db.getState(key);
  const fresh = cached && now() - (cached.fetchedAt ?? 0) < MAX_AGE;
  // Fresh value AND enough history 鈫?nothing to do. A fresh value with a
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
    // Bootstrap: delta5d needs 鈮? points; one-shot best-effort seed from the
    // daily kline (failures retry next cycle 鈥?the gate keeps values < 2 open).
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
      } catch { /* seed failure 鈫?next cycle retries */ }
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
    // Bootstrap from ECB history (frankfurter, base USD 鈫?same per-USD shape)
    // so the 5-day delta works from day one.
    if ((entry.values?.length ?? 0) < 2) {
      try {
        const start = new Date(now() - 60 * DAY).toISOString().slice(0, 10);
        const h = await fetchFn(`https://api.frankfurter.app/${start}..?from=USD`, {
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'Mozilla/5.0' },
        });
        if (h.ok) entry = { ...entry, values: mergeHistory(parseFrankfurterDxy(await h.json()), entry.values ?? []).slice(-60) };
      } catch { /* seed failure 鈫?next cycle retries */ }
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
