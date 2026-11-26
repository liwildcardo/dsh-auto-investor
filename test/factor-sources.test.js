import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import {
  parseEmQuote, parseEmKlines, parseFrankfurterDxy, computeDxy,
  collectFactors, readFactors, peFromQuote, pairSeries,
} from '../core/factor-sources.js';

const DAY = 86_400_000;

function harness(t) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-factor-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  return db;
}

test('parseEmQuote scales f43 by 1000 and reads the quote date', () => {
  const now = () => Date.parse('2026-11-09T12:00:00Z');
  const p = parseEmQuote({ data: { f43: 26190, f86: 1794231430, f58: '美国10年期通胀国债收益率' } }, now);
  assert.ok(Math.abs(p.value - 2.619) < 1e-9, `value 2.619, got ${p.value}`);
  assert.equal(p.asOf, '2026-11-09', 'Shanghai date of the quote');
  assert.equal(p.name, '美国10年期通胀国债收益率');
  assert.equal(parseEmQuote({ data: { f86: 1 } }, now), null, 'missing f43 → null');
  assert.equal(parseEmQuote(null, now), null);
});

test('computeDxy matches the standard formula on a known rate vector', () => {
  const rates = { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 };
  const expected = 50.14348112
    * Math.pow(1 / 0.85, 0.576)
    * Math.pow(150, 0.136)
    * Math.pow(1 / 0.75, 0.119)
    * Math.pow(1.37, 0.091)
    * Math.pow(10.7, 0.042)
    * Math.pow(0.88, 0.036);
  const dxy = computeDxy(rates);
  assert.ok(Math.abs(dxy - expected) < 1e-9);
  assert.ok(dxy > 80 && dxy < 130, `plausible index level, got ${dxy}`);
  assert.equal(computeDxy({ EUR: 0.85 }), null, 'missing rates → null');
});

test('factor fetch caches for 26h and failures fall back to the cache', async (t) => {
  const db = harness(t);
  let clock = Date.UTC(2026, 10, 9, 4, 0);
  const now = () => clock;
  let calls = 0;
  let fail = false;
  const fetchFn = async (url) => {
    calls += 1;
    if (fail) throw new Error('network down');
    if (String(url).includes('push2his')) {
      return { ok: true, json: async () => ({ data: { klines: ['2026-11-03,2.60,2.66', '2026-11-04,2.66,2.58'] } }) };
    }
    if (String(url).includes('frankfurter')) {
      return { ok: true, json: async () => ({ rates: { '2026-11-03': { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } } }) };
    }
    if (String(url).includes('push2.eastmoney.com')) {
      return { ok: true, json: async () => ({ data: { f43: 26190, f86: Math.floor(clock / 1000) } }) };
    }
    // 金银比采集器走 gold-api：载荷是 {price} 而非汇率形，解析失败会让
    // fetchedAt 恒为 0、门失效（本用例测的就是"新鲜即不重抓"）。
    if (String(url).includes('api.gold-api.com/price/XAU')) {
      return { ok: true, json: async () => ({ price: 4100 }) };
    }
    if (String(url).includes('api.gold-api.com/price/XAG')) {
      return { ok: true, json: async () => ({ price: 41 }) };
    }
    return { ok: true, json: async () => ({ rates: { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } }) };
  };
  const first = await collectFactors(fetchFn, db, now);
  const callsAfterFirst = calls;
  assert.ok(calls >= 1, 'initial fetch happened');
  assert.ok(Math.abs(first.realYield.value - 2.619) < 1e-9, 'scaled value');
  assert.equal(first.realYield.stale, false, 'fresh data');
  assert.ok(Number.isFinite(first.realYield.delta5d), 'seeded on first collect → delta available');

  // Second collect within 26h: no refetch.
  await collectFactors(fetchFn, db, now);
  assert.equal(calls, callsAfterFirst, 'fresh cache skips refetch');

  // Beyond 26h the network fails → cache survives; asOf is now more than
  // 5 days old → stale flag set, error diagnostics recorded.
  clock += 6 * DAY;
  fail = true;
  const degraded = await collectFactors(fetchFn, db, now);
  assert.ok(degraded.realYield, 'cache used on failure');
  assert.equal(degraded.realYield.value, 2.619, 'values preserved');
  assert.ok(degraded.realYield.stale, 'older than 5 days → stale');
});

test('factors older than 5 days are marked stale (signal will neutralize)', (t) => {
  const db = harness(t);
  db.putState('factor:em:UI10Y', {
    values: [{ date: '2026-10-01', value: 2.2 }, { date: '2026-10-02', value: 2.1 }],
    asOf: '2026-10-02', fetchedAt: Date.now(),
  });
  const fresh = readFactors(db, () => Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(fresh.realYield.stale, false, '3 days old → fresh');
  const old = readFactors(db, () => Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(old.realYield.stale, true, '38 days old → stale');
});

test('readFactors derives delta5d in percentage points and percent', (t) => {
  const db = harness(t);
  db.putState('factor:em:UI10Y', {
    values: [
      { date: '2026-11-01', value: 2.20 },
      { date: '2026-11-08', value: 2.05 }, // −15bp over 7 days
    ],
    asOf: '2026-11-08', fetchedAt: Date.now(),
  });
  db.putState('factor:usdIndex', {
    values: [
      { date: '2026-11-01', value: 100 },
      { date: '2026-11-08', value: 99 }, // −1%
    ],
    value: 99, asOf: '2026-11-08', fetchedAt: Date.now(),
  });
  const f = readFactors(db, () => Date.parse('2026-11-09T00:00:00Z'));
  assert.ok(Math.abs(f.realYield.delta5d - (-0.15)) < 1e-9, 'pp difference');
  assert.ok(Math.abs(f.usdIndex.delta5d - (-1)) < 1e-9, 'percent change');
  assert.equal(f.inflationExp, undefined, 'dropped: no free source');
});

test('parseEmKlines reads the close column and skips junk rows', () => {
  const rows = parseEmKlines(['2026-09-01,2.4312,2.4425', 'garbage', '2026-09-02,2.4425,2.4351,x']);
  assert.deepEqual(rows, [
    { date: '2026-09-01', value: 2.4425 },
    { date: '2026-09-02', value: 2.4351 },
  ]);
  assert.equal(parseEmKlines(undefined).length, 0);
});

test('parseFrankfurterDxy computes DXY per date from ECB rates', () => {
  const rates = { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 };
  const rows = parseFrankfurterDxy({ rates: { '2026-11-03': rates, '2026-11-04': { EUR: 0.85 } } });
  assert.equal(rows.length, 1, 'rows with missing currencies are skipped');
  assert.equal(rows[0].date, '2026-11-03');
  assert.ok(rows[0].value > 80 && rows[0].value < 130);
});

test('history seeding unlocks delta5d on the first collect', async (t) => {
  const db = harness(t);
  const now = () => Date.UTC(2026, 10, 9, 4, 0);
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('push2his')) {
      return { ok: true, json: async () => ({ data: { klines: ['2026-11-03,2.60,2.66', '2026-11-04,2.66,2.58', '2026-11-05,2.58,2.55'] } }) };
    }
    if (u.includes('push2.eastmoney.com')) {
      return { ok: true, json: async () => ({ data: { f43: 26174, f86: Math.floor(now() / 1000) } }) };
    }
    if (u.includes('frankfurter')) {
      return { ok: true, json: async () => ({ rates: { '2026-11-03': { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } } }) };
    }
    return { ok: true, json: async () => ({ rates: { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } }) };
  };
  const f = await collectFactors(fetchFn, db, now);
  const stored = db.getState('factor:em:UI10Y');
  assert.ok(stored.values.length >= 4, `history seeded, got ${stored.values.length}`);
  assert.ok(Number.isFinite(f.realYield.delta5d), `realYield delta available, got ${f.realYield.delta5d}`);
  assert.ok(Math.abs(f.realYield.value - 2.6174) < 1e-9, 'current quote value');
  assert.ok(Number.isFinite(f.usdIndex.delta5d), 'usd delta seeded from ECB history');
});

test('a fresh single-point cache still seeds history without a quote refetch', async (t) => {
  const db = harness(t);
  const now = () => Date.UTC(2026, 10, 9, 4, 0);
  // Fresh (fetched minutes ago) but only one history point — the 26h gate
  // must not block the seed (this exact state existed in production).
  db.putState('factor:em:UI10Y', { values: [{ date: '2026-11-09', value: 2.6174 }], asOf: '2026-11-09', fetchedAt: now() - 60_000 });
  db.putState('factor:usdIndex', { values: [{ date: '2026-11-09', value: 124.13 }], value: 124.13, asOf: '2026-11-09', fetchedAt: now() - 60_000 });
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('push2his')) return { ok: true, json: async () => ({ data: { klines: ['2026-11-03,2.60,2.66', '2026-11-04,2.66,2.58'] } }) };
    if (u.includes('frankfurter')) return { ok: true, json: async () => ({ rates: { '2026-11-03': { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } } }) };
    return { ok: true, json: async () => ({ data: { f43: 99999 }, rates: {} }) };
  };
  const f = await collectFactors(fetchFn, db, now);
  // 断言收窄到 UI10Y 报价端点本身：US10Y/US02Y 是新缓存键（首抓正常），
  // UI10Y 的历史播种走 push2his kline（另一端点，允许）。
  assert.ok(
    !calls.some(u => u.includes('push2.eastmoney.com/api/qt/stock/get') && u.includes('secid=171.UI10Y')),
    'fresh UI10Y quote not refetched',
  );
  assert.ok(!calls.some(u => u.includes('open.er-api.com')), 'fresh fx not refetched');
  assert.ok(Number.isFinite(f.realYield.delta5d), `seed ran despite fresh gate, got ${f.realYield.delta5d}`);
  assert.ok(Number.isFinite(f.usdIndex.delta5d), 'usd seeded too');
  assert.ok(Math.abs(f.realYield.value - 2.6174) < 1e-9, 'current value preserved');
});

test('peFromQuote reads field 39 across markets', () => {
  const mk = (pe39) => Array.from({ length: 50 }, (_, i) => (i === 39 ? String(pe39) : '0'));
  assert.equal(peFromQuote(mk('21.99')), 21.99, 'A-share Maotai');
  assert.equal(peFromQuote(mk('15.28')), 15.28, 'HK Tencent');
  assert.equal(peFromQuote(mk('38.13')), 38.13, 'US AAPL');
  assert.equal(peFromQuote(mk('')), null, 'empty → null');
  assert.equal(peFromQuote(mk('-3')), null, 'negative → null');
  assert.equal(peFromQuote(undefined), null);
});

test('pairSeries 同日与近距配对（≤4 天）', () => {
  const a = {
    values: [{ date: '2026-11-20', value: 4.2 }, { date: '2026-11-21', value: 4.1 }],
    asOf: '2026-11-21', fetchedAt: 1,
  };
  const b = {
    values: [
      { date: '2026-11-18', value: 1.9 }, // 3 天前的观测（近距可用）
      { date: '2026-11-20', value: 2.1 },
      { date: '2026-11-21', value: 2.2 },
    ],
    asOf: '2026-11-21', fetchedAt: 1,
  };
  const p = pairSeries(a, b);
  assert.equal(p.values.length, 2, '两条 a 观测各配一条 b');
  assert.ok(Math.abs(p.values[0].value - (4.2 - 2.1)) < 1e-9, '同日配对');
  assert.ok(Math.abs(p.value - (4.1 - 2.2)) < 1e-9, 'value = 最后一对差值');
  assert.equal(p.asOf, '2026-11-21', 'asOf 取最后一对日期');
});

test('pairSeries 超过 4 天的观测跳过 → null', () => {
  const a = { values: [{ date: '2026-11-21', value: 4.1 }], asOf: '2026-11-21', fetchedAt: 1 };
  const b = { values: [{ date: '2026-11-15', value: 2.0 }], asOf: '2026-11-15', fetchedAt: 1 };
  assert.equal(pairSeries(a, b), null, '6 天间隔不配对');
});

test('readFactors 派生 breakeven（us10−ui10）与 yieldCurve（us10−us02）', (t) => {
  const db = harness(t);
  const d1 = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
  const d2 = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const seed = (key, v1, v2) => db.putState(key, {
    values: [{ date: d1, value: v1 }, { date: d2, value: v2 }],
    asOf: d2, fetchedAt: Date.now(),
  });
  seed('factor:em:US10Y', 4.2, 4.1);
  seed('factor:em:UI10Y', 1.9, 1.95);
  seed('factor:em:US02Y', 3.6, 3.5);
  const f = readFactors(db);
  assert.equal(f.us10Y.value, 4.1, '名义 10Y 直读');
  assert.ok(Math.abs(f.breakeven.value - (4.1 - 1.95)) < 1e-9, 'breakeven = us10 − ui10');
  assert.ok(Math.abs(f.yieldCurve.value - (4.1 - 3.5)) < 1e-9, 'yieldCurve = us10 − us02');
  assert.equal(f.breakeven.stale, false, '新数据不标过期');
  assert.ok(Number.isFinite(f.breakeven.delta5d), '派生量带 delta5d');
});

test('readFactors 缺源时对应派生量为 null', (t) => {
  const db = harness(t);
  const d = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  const seed = (key, v) => db.putState(key, { values: [{ date: d, value: v }], asOf: d, fetchedAt: Date.now() });
  seed('factor:em:US10Y', 4.1);
  seed('factor:em:UI10Y', 1.95);
  const f = readFactors(db);
  assert.ok(Math.abs(f.breakeven.value - (4.1 - 1.95)) < 1e-9, '两源齐 → breakeven 可算');
  assert.equal(f.yieldCurve, null, '缺 us02 → yieldCurve null');
  assert.equal(f.us02Y, null, '缺源字段 null');
});

/** gold-api 双端点 + 东财 + er-api 的统一 mock（collectFactors 全路覆盖）。 */
function allFetch({ onGold = null, failAll = false } = {}) {
  let xauCalls = 0;
  const fn = async (url) => {
    const u = String(url);
    if (failAll) throw new Error('network down');
    if (u.includes('price/XAU')) {
      xauCalls += 1;
      return { ok: true, json: async () => ({ price: 4000 + xauCalls }) };
    }
    if (u.includes('price/XAG')) return { ok: true, json: async () => ({ price: 40 }) };
    if (u.includes('push2his')) return { ok: true, json: async () => ({ data: { klines: ['2026-11-20,2.6,2.66', '2026-11-21,2.66,2.58'] } }) };
    if (u.includes('push2.eastmoney.com')) return { ok: true, json: async () => ({ data: { f43: 26190, f86: Math.floor(Date.now() / 1000) } }) };
    if (u.includes('frankfurter')) return { ok: true, json: async () => ({ rates: {} }) };
    return { ok: true, json: async () => ({ rates: { CNY: 7.1 } }) };
  };
  fn.xauCalls = () => xauCalls;
  return fn;
}

test('金银比采集：30 分钟门与按日累积', async (t) => {
  const db = harness(t);
  let clock = Date.UTC(2026, 10, 25, 2, 0); // 上海 10:00
  const now = () => clock;
  const fetchFn = allFetch();
  const f1 = await collectFactors(fetchFn, db, now);
  const calls1 = fetchFn.xauCalls();
  assert.ok(calls1 >= 1, '首抓发生');
  assert.ok(f1.goldSilverRatio?.value > 90, `ratio = XAU/XAG ≈ 100, got ${f1.goldSilverRatio?.value}`);
  assert.equal(f1.goldSilverRatio.stale, false);

  clock += 20 * 60_000; // 门内
  await collectFactors(fetchFn, db, now);
  assert.equal(fetchFn.xauCalls(), calls1, '30 分钟门内不重抓');

  clock += 11 * 60_000; // 累计 31 分钟
  await collectFactors(fetchFn, db, now);
  assert.equal(fetchFn.xauCalls(), calls1 + 1, '过门重抓');
  const cached = db.getState('factor:xauXagRatio');
  const d = new Date(clock + 8 * 3600_000).toISOString().slice(0, 10);
  assert.equal(cached.values.filter((v) => v.date === d).length, 1, '同日覆盖，不重复累积');
  assert.ok(readFactors(db, now).goldSilverRatio?.value > 90, 'readFactors 读同一缓存键');
});

test('金银比采集：失败沿用旧缓存并记 fetchedAt:0', async (t) => {
  const db = harness(t);
  let clock = Date.UTC(2026, 10, 25, 2, 0);
  const now = () => clock;
  const okFetch = allFetch();
  const f1 = await collectFactors(okFetch, db, now);
  assert.ok(f1.goldSilverRatio?.value > 0, '首次成功');

  clock += 31 * 60_000;
  const failFetch = allFetch({ failAll: true });
  const f2 = await collectFactors(failFetch, db, now);
  assert.ok(f2.goldSilverRatio?.value > 0, '失败时旧值存活');
  const cached = db.getState('factor:xauXagRatio');
  assert.equal(cached.fetchedAt, 0, 'fetchedAt 0 → 下轮立即重试');
  assert.match(String(cached.error), /network down/, '错误可观测');
});
