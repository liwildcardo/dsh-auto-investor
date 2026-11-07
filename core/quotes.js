/**
 * 行情适配器：腾讯行情（A股/美股/港股通用）。返回统一结构：
 * { symbol, price, prevClose, open, volume, currency }
 */

const FIELD = { price: 3, prevClose: 4, open: 5, volume: 6 };

/** Parse the `v_sh600000="1~name~code~..."` payload into normalized quotes. */
export function parseTencent(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/v_([a-z]{2}[A-Za-z0-9.]+)="([^"]*)"/g)) {
    const [, symbol, body] = m;
    const f = body.split('~');
    const price = Number(f[FIELD.price]);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      symbol,
      price,
      prevClose: Number(f[FIELD.prevClose]) || null,
      open: Number(f[FIELD.open]) || null,
      volume: Number(f[FIELD.volume]) || 0,
      currency: symbol.startsWith('us') ? 'USD' : symbol.startsWith('hk') ? 'HKD' : 'CNY',
    });
  }
  return out;
}

/** Batch quote fetch (Tencent accepts comma-separated codes, ~60 per request). */
export async function fetchQuotes(fetchFn, symbols, timeoutMs = 8000) {
  const list = [...new Set((symbols ?? []).filter(Boolean))];
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const url = `https://qt.gtimg.cn/q=${chunk.join(',')}`;
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://gu.qq.com/' },
    });
    if (!res.ok) throw new Error(`quote http ${res.status}`);
    out.push(...parseTencent(await res.text()));
  }
  return out;
}

/** FX rate (1 unit of `from` in CNY): USDCNY / HKDCNY via er-api. */
export async function fetchFxRate(fetchFn, from = 'USD', timeoutMs = 8000) {
  const res = await fetchFn(`https://open.er-api.com/v6/latest/${from}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`fx http ${res.status}`);
  const json = await res.json();
  const rate = json?.rates?.CNY;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('fx rate missing');
  return rate;
}

/**
 * Daily close/open/volume history (Tencent kline). Seeds indicators on a fresh
 * install so trend/momentum/RSI can compute before enough live ticks exist.
 * Returns [{ts, price, open, high, low, volume}] oldest first.
 */
export async function fetchDailyHistory(fetchFn, symbol, count = 120, timeoutMs = 10000) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(symbol)},day,,,${count},qfq`;
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://gu.qq.com/' },
  });
  if (!res.ok) throw new Error(`history http ${res.status}`);
  const json = await res.json();
  const node = json?.data?.[symbol] ?? json?.data?.[symbol.toLowerCase()] ?? null;
  const rows = node?.qfqday ?? node?.day ?? [];
  const out = [];
  const cutoff = Date.now() - 2 * 365 * 86_400_000; // ignore stale/misparsed bars
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const ts = Date.parse(`${r[0]}T00:00:00+08:00`);
    const price = Number(r[2]);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0 || ts < cutoff) continue;
    out.push({
      ts,
      price,
      open: Number(r[1]) || null,
      high: Number(r[3]) || null,
      low: Number(r[4]) || null,
      volume: Number(r[5]) || null,
    });
  }
  return out;
}

/**
 * Intraday minute history (Tencent) — fallback when daily bars are thin or
 * missing (e.g. US symbols). Returns [{ts, price, volume}] oldest first.
 */
export async function fetchMinuteHistory(fetchFn, symbol, timeoutMs = 10000) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(symbol)}`;
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://gu.qq.com/' },
  });
  if (!res.ok) throw new Error(`minute http ${res.status}`);
  const json = await res.json();
  const node = json?.data?.[symbol] ?? null;
  const rows = node?.data?.data ?? [];
  const day = String(node?.data?.date ?? '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const out = [];
  for (const row of rows) {
    const parts = String(row).trim().split(/\s+/);
    if (parts.length < 2) continue;
    const hhmm = parts[0];
    const price = Number(parts[1]);
    if (!/^\d{4}$/.test(hhmm) || !Number.isFinite(price) || price <= 0) continue;
    const ts = Date.parse(`${day || '1970-01-01'}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00+08:00`);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, price, volume: Number(parts[2]) || null });
  }
  return out;
}


