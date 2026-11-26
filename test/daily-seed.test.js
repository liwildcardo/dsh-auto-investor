import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { normalizeProduct } from '../core/product.js';
import { createProductEngine } from '../core/engine.js';
import { fetchKline, fetchDailyHistory, fetchEmDaily } from '../core/quotes.js';

// 2026-11-06 Friday 10:00 Shanghai（黄金时段内）
const OPEN = Date.UTC(2026, 10, 6, 2, 0);
const DAY = 86_400_000;

/** 60 个连续交易日的东财日K行（date,open,close,high,low,volume），截止 OPEN 前一天。 */
function emKlines(n = 60) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(OPEN - (n - i) * DAY).toISOString().slice(0, 10);
    out.push(`${d},${400 + i},${400.5 + i},${401 + i},${399 + i},1000`);
  }
  return out;
}

test('fetchKline 周线/日线 URL 与行解析', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    urls.push(u);
    const isWeek = u.includes(',week,');
    // 腾讯 K 线列序：date, open, close, high, low, volume
    const row = ['2026-11-20', '3300', '3305', '3310', '3290', '1000'];
    return {
      ok: true,
      json: async () => ({
        data: {
          sh000001: isWeek ? { qfqweek: [row] } : { qfqday: [row] },
        },
      }),
    };
  };
  const week = await fetchKline(fetchFn, 'sh000001', 'week', 50);
  assert.ok(urls[0].includes('sh000001,week,,,50,qfq'), urls[0]);
  assert.equal(week.length, 1);
  assert.equal(week[0].price, 3305, 'close 列');
  assert.equal(week[0].open, 3300);
  assert.equal(week[0].high, 3310);
  assert.equal(week[0].low, 3290);
  assert.equal(week[0].volume, 1000);
  assert.ok(Number.isFinite(week[0].ts), 'ts 可解析');

  // 既有签名委托：fetchDailyHistory 行为不变
  const day = await fetchDailyHistory(fetchFn, 'sh000001', 120);
  assert.ok(urls[1].includes('sh000001,day,,,120,qfq'), urls[1]);
  assert.equal(day.length, 1);
  assert.equal(day[0].price, 3305);
});

test('fetchEmDaily 解析东财日K（date,open,close,high,low,volume）', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        data: {
          klines: [
            '2026-11-20,450.1,452.0,453.0,449.0,12345',
            '2026-11-21,452.0,453.5,455.0,451.0,23456',
          ],
        },
      }),
    };
  };
  const rows = await fetchEmDaily(fetchFn, '118.AU9999', 400);
  assert.ok(urls[0].includes('secid=118.AU9999'), urls[0]);
  assert.ok(urls[0].includes('klt=101'), '日K');
  assert.ok(urls[0].includes('beg='), 'beg = now - days');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price, 452, 'close 列');
  assert.equal(rows[0].open, 450.1);
  assert.equal(rows[0].high, 453);
  assert.equal(rows[0].low, 449);
  assert.equal(rows[0].volume, 12345);
  assert.ok(Number.isFinite(rows[0].ts));

  // 3 列老格式（date,open,close）→ 高/低/量为 null，收盘价仍可用
  const three = await fetchEmDaily(
    async () => ({ ok: true, json: async () => ({ data: { klines: ['2026-11-20,450.1,452.0'] } }) }),
    '118.AU9999',
  );
  assert.equal(three[0].price, 452);
  assert.equal(three[0].high, null);
  assert.equal(three[0].volume, null);
});

function harness(t, { rows = 60, llm } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-seed-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  let clock = OPEN;
  let emCalls = 0;
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('push2his.eastmoney.com')) {
      emCalls += 1;
      return { ok: true, json: async () => ({ data: { klines: emKlines(rows) } }) };
    }
    if (u.includes('api.gold-api.com/price/XAU')) return { ok: true, json: async () => ({ price: 4000 }) };
    if (u.includes('open.er-api.com')) {
      return { ok: true, json: async () => ({ rates: { CNY: 7.1, EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } }) };
    }
    return { ok: true, json: async () => ({ data: { f43: 26190, f86: Math.floor(OPEN / 1000) }, rates: {} }) };
  };
  const product = normalizeProduct({
    id: 'goldseed',
    name: '金种',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: {
      kind: 'single',
      dailySeed: { kind: 'em', secid: '118.AU9999' },
      async quote() { return { price: 4050, buy: 4052, sell: 4048, ts: OPEN, currency: 'CNY' }; },
    },
    universe: { watchlist: () => [{ symbol: 'AU9999', name: '黄金', lot: 1 }], lotSize: 1 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: {
      barInterval: '1h',
      signals: [{ id: 'trend', params: { fast: 5, slow: 20 }, weight: 1 }],
      candidates: { threshold: 0.8 },
      prompt: {},
      decision: {},
      evolvable: [],
    },
    rules: { unit: 'gram', lotSize: 1, settlement: 'T+0', fees: { spreadCnyPerGram: 5 }, sessions: [[550, 1560]], holidays: [] },
    risk: { perTrade: 5000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -5, takeProfitPct: 50, dailyLossPct: -99, minSamplesToEvolve: 0 },
  });
  const engine = createProductEngine({
    db, product, fetchFn,
    llm: llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 })),
    now: () => clock,
  });
  return { engine, db, emCalls: () => emCalls, product, advance: (ms) => { clock += ms; } };
}

test('seedHistory 为 single 产品播种黄金日线（入 series、30 分钟节流）', async (t) => {
  const { engine, db, emCalls } = harness(t);
  await engine.tick();
  const points = db.listPoints('goldseed', 'AU9999', 5000);
  assert.equal(points.length, 60, `60 条日线种子入 series, got ${points.length}`);
  assert.ok(points.every((p) => Number.isFinite(p.price) && p.price > 390 && p.price < 470), 'close 价');
  assert.ok(points.every((p) => Number.isFinite(p.open) && Number.isFinite(p.high) && Number.isFinite(p.volume)), 'OHLCV 保留（供后续 ATR）');
  const ticks = db.latestTicksByProduct('goldseed', 5000);
  assert.equal(ticks.length, 1, '种子不进 ticks（仅时段内实时报价）');

  const calls = emCalls();
  await engine.tick();
  assert.equal(emCalls(), calls, '计数门：已达 60 根不再重抓');
});

test('seedHistory 部分种子（<60 根）由 30 分钟节流门拦截重抓', async (t) => {
  const { engine, db, emCalls } = harness(t, { rows: 40 });
  await engine.tick();
  assert.equal(db.listPoints('goldseed', 'AU9999', 5000).length, 40, '40 条种子（未达计数门）');
  const calls = emCalls();
  await engine.tick();
  assert.equal(emCalls(), calls, '节流门：30 分钟内不重抓');
});

test('瘦源重种按 ts 去重：节流过期重抓不产生重复行', async (t) => {
  const { engine, db, emCalls, advance } = harness(t, { rows: 40 });
  await engine.tick();
  assert.equal(db.listPoints('goldseed', 'AU9999', 5000).length, 40, '首播 40 行');
  advance(31 * 60_000); // 过节流门
  await engine.tick();
  assert.ok(emCalls() >= 2, '节流过期后确实重抓');
  assert.equal(db.listPoints('goldseed', 'AU9999', 5000).length, 40, '相同 ts 的行被跳过，无重复');
});

test('fetchEmDaily 按指定时区构建日界 ts', async () => {
  const kline = async () => ({ ok: true, json: async () => ({ data: { klines: ['2026-11-20,450.1,452.0'] } }) });
  const [sh] = await fetchEmDaily(kline, '118.AU9999', 400);
  assert.equal(sh.ts, Date.parse('2026-11-20T00:00:00+08:00'), '默认上海午夜');
  const [ny] = await fetchEmDaily(kline, '118.AU9999', 400, 'America/New_York');
  assert.equal(ny.ts, Date.parse('2026-11-20T00:00:00-05:00'), '纽约午夜（11 月 EST）');
  const [tokyo] = await fetchEmDaily(kline, '118.AU9999', 400, 'Asia/Tokyo');
  assert.equal(tokyo.ts, Date.parse('2026-11-20T00:00:00+09:00'), '东京午夜');
});

test('prompt 宏观块显示新因子（通胀预期/收益率曲线/金银比）', async (t) => {
  let prompt = null;
  const { engine } = harness(t, {
    llm: async (p) => {
      prompt = p;
      return JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 });
    },
  });
  await engine.runCycle();
  assert.ok(prompt, 'LLM 被调用并拿到 prompt');
  assert.match(prompt, /实际收益率/, '既有因子仍在');
  assert.match(prompt, /通胀预期/, 'breakeven 因子行');
  assert.match(prompt, /收益率曲线/, 'yieldCurve 因子行');
  assert.match(prompt, /金银比/, 'goldSilverRatio 因子行');
});

test('种子不污染 1h 信号 bar 与日开盘基准（Review Focus 3）', async (t) => {
  const { engine, db } = harness(t);
  await engine.tick();

  // 1h bar 只含时段内实时 tick：种子在 series，结构上进不了 1h 桶
  const h1 = engine.signalBars('AU9999', '1h');
  assert.equal(h1.length, 1, `1h 只含实时 tick, got ${h1.length}`);
  assert.equal(h1[0], 4050);

  // 1d bar 含 60 条种子 + 当日实时价（回测数据源）
  const d1 = engine.signalBars('AU9999', '1d');
  assert.ok(d1.length >= 60, `1d 含种子, got ${d1.length}`);
  assert.equal(d1.at(-1), 4050, '最新日 bar = 实时价');

  // 日开盘基准 = 时段内首个实时 tick，而非午夜种子
  const key = `product:goldseed:dayOpen:${new Date(OPEN + 8 * 3600_000).toISOString().slice(0, 10)}`;
  const dayOpen = db.getState(key);
  assert.ok(dayOpen, `day-open recorded under ${key}`);
  const rec = dayOpen.AU9999;
  const price = typeof rec === 'object' ? rec.price : rec;
  assert.equal(price, 4050, '日开盘取时段内首个实时 tick');
});
