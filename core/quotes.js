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
