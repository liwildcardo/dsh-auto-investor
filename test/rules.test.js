import test from 'node:test';
import assert from 'node:assert/strict';
import { isTradingTime, validateTrade } from '../lib/rules.js';
import { createPortfolio, buy } from '../lib/portfolio.js';
import { resolveConfig } from '../lib/config.js';

const cfg = resolveConfig({});
const quote = { mid: 848.51, buy: 851.01, sell: 846.01 };

// Asia/Shanghai wall-clock helper: build a Date at given UTC ms offset.
// 2026-11-02 is a Monday. +08:00 => 09:10 local = 01:10 UTC.
function sh(localHour, localMin, day = 2) {
  return new Date(Date.UTC(2026, 10, day, localHour - 8, localMin));
}

test('trading window opens at 9:10 and closes at 02:00', () => {
  assert.equal(isTradingTime(sh(9, 9), cfg), false);
  assert.equal(isTradingTime(sh(9, 10), cfg), true);
  assert.equal(isTradingTime(sh(23, 0), cfg), true);
  // Tuesday 01:59 continues Monday's session; Monday 01:59 continues Sunday's (none)
  assert.equal(isTradingTime(sh(1, 59, 3), cfg), true);
  assert.equal(isTradingTime(sh(1, 59), cfg), false);
  assert.equal(isTradingTime(sh(2, 1, 3), cfg), false);
  assert.equal(isTradingTime(sh(2, 0, 3), cfg), false);
});

test('weekends and holidays are not trading days', () => {
  // 2026-11-07 is a Saturday
  assert.equal(isTradingTime(sh(10, 0, 7), cfg), false);
  const withHoliday = resolveConfig({ holidays: ['2026-11-03'] });
  assert.equal(isTradingTime(sh(10, 0, 3), withHoliday), false);
  assert.equal(isTradingTime(sh(10, 0, 4), withHoliday), true);
});

test('early-morning session belongs to the previous trading day', () => {
  // Saturday 01:00 continues Friday's session -> allowed; Sunday 01:00 is not
  assert.equal(isTradingTime(sh(1, 0, 7), cfg), true); // Sat 01:00 after Friday
  assert.equal(isTradingTime(sh(1, 0, 8), cfg), false); // Sun 01:00 after Saturday
});

function fresh() {
  const p = createPortfolio(cfg.initialCapitalRmb);
  return p;
}

test('trade rejected outside trading window', () => {
  const r = validateTrade({ side: 'buy', rmb: 2000, ts: sh(3, 0).getTime() }, fresh(), quote, cfg);
  assert.equal(r.ok, false);
  assert.match(r.reason, /window|时段/);
});

test('per-trade cap 5000 RMB enforced', () => {
  const r = validateTrade({ side: 'buy', rmb: 5001, ts: sh(10, 0).getTime() }, fresh(), quote, cfg);
  assert.equal(r.ok, false);
  assert.match(r.reason, /5000|单笔/);
});

test('cumulative invested cap 100000 RMB enforced', () => {
  const p = fresh();
  p.investedRmb = 99000;
  const r = validateTrade({ side: 'buy', rmb: 2000, ts: sh(10, 0).getTime() }, p, quote, cfg);
  assert.equal(r.ok, false);
  assert.match(r.reason, /100000|总额/);
});

test('minimum trade 1克 / 1200元 enforced', () => {
  const r1 = validateTrade({ side: 'buy', rmb: 1100, ts: sh(10, 0).getTime() }, fresh(), quote, cfg);
  assert.equal(r1.ok, false);
  const r2 = validateTrade({ side: 'buy', rmb: 1200, ts: sh(10, 0).getTime() }, fresh(), quote, cfg);
  assert.equal(r2.ok, true);
  // 1200元 at ~851元/克 = 1.41克 >= 1克 ok; 850元 would be < 1克 and < 1200元 anyway
});

test('valid buy within all limits passes', () => {
  const r = validateTrade({ side: 'buy', rmb: 5000, ts: sh(10, 0).getTime() }, fresh(), quote, cfg);
  assert.equal(r.ok, true);
});

test('sell requires holdings', () => {
  const r = validateTrade({ side: 'sell', grams: 1, ts: sh(10, 0).getTime() }, fresh(), quote, cfg);
  assert.equal(r.ok, false);
  assert.match(r.reason, /持仓|holdings/);
});

test('to-term requires 10克起 and available demand grams', () => {
  const p = fresh();
  buy(p, 5000, 851.01); // ~5.87克
  // insufficient demand grams for a 10克 transfer
  const r = validateTrade({ side: 'toTerm', grams: 10, ts: sh(10, 0).getTime() }, p, quote, cfg);
  assert.equal(r.ok, false);
  // < 10克 request rejected outright
  const r3 = validateTrade({ side: 'toTerm', grams: 9.9, ts: sh(10, 0).getTime() }, p, quote, cfg);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /10/);
  // with enough demand grams, 10克 passes
  buy(p, 5000, 851.01); // ~11.75克 total
  const r2 = validateTrade({ side: 'toTerm', grams: 10, ts: sh(10, 0).getTime() }, p, quote, cfg);
  assert.equal(r2.ok, true);
});
