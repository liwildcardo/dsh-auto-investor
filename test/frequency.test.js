import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFrequency, validateTrade } from '../lib/rules.js';
import { createPortfolio, buy } from '../lib/portfolio.js';
import { resolveConfig } from '../lib/config.js';

const cfg = resolveConfig({});
const quote = { mid: 848.51, buy: 851.01, sell: 846.01 };
const HOUR = 3600_000;
const base = Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 Shanghai

// ---------- trade frequency as part of strategy (issue: 3 trades per morning) ----------

const swingPlan = { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 4 };

test('checkFrequency allows first trade of the day', () => {
  const r = checkFrequency([], swingPlan, base);
  assert.equal(r.ok, true);
});

test('checkFrequency rejects beyond maxTradesPerDay market trades', () => {
  const trades = [
    { ts: base - 5 * HOUR, side: 'buy' },
    { ts: base - 1 * HOUR, side: 'buy' },
  ];
  const r = checkFrequency(trades, swingPlan, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /每日|per day|maxTradesPerDay/);
});

test('checkFrequency enforces minIntervalHours between trades', () => {
  const trades = [{ ts: base - 1 * HOUR, side: 'buy' }]; // 1h ago, 2nd trade allowed by count
  const r = checkFrequency(trades, swingPlan, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /间隔|interval/i);
  const r2 = checkFrequency(trades, swingPlan, base + 4 * HOUR);
  assert.equal(r2.ok, true);
});

test('checkFrequency ignores toTerm/fromTerm conversions', () => {
  const trades = [
    { ts: base - 1 * HOUR, side: 'toTerm' },
    { ts: base - 2 * HOUR, side: 'fromTerm' },
    { ts: base - 3 * HOUR, side: 'toTerm' },
  ];
  const r = checkFrequency(trades, swingPlan, base);
  assert.equal(r.ok, true);
});

test('checkFrequency counts only same-calendar-day trades', () => {
  const yesterday = [{ ts: base - 26 * HOUR, side: 'buy' }, { ts: base - 27 * HOUR, side: 'buy' }];
  const r = checkFrequency(yesterday, swingPlan, base);
  assert.equal(r.ok, true); // yesterday's trades don't consume today's quota
});

test('validateTrade rejects when frequency plan is exceeded', () => {
  const p = createPortfolio(cfg.initialCapitalRmb);
  buy(p, 2000, 851.01);
  const trades = [{ ts: base - 1 * HOUR, side: 'buy' }, { ts: base - 2 * HOUR, side: 'buy' }];
  const r = validateTrade({ side: 'buy', rmb: 2000, ts: base }, p, quote, cfg, { plan: swingPlan, trades });
  assert.equal(r.ok, false);
});

test('validateTrade passes frequency gate when plan allows', () => {
  const p = createPortfolio(cfg.initialCapitalRmb);
  const r = validateTrade({ side: 'buy', rmb: 2000, ts: base }, p, quote, cfg, { plan: swingPlan, trades: [] });
  assert.equal(r.ok, true);
});

test('frequency plan is clamped by global hard caps', () => {
  const p = createPortfolio(cfg.initialCapitalRmb);
  const wild = { style: 'day', maxTradesPerDay: 99, minIntervalHours: 0 };
  const trades = [
    { ts: base - HOUR / 2, side: 'buy' },
    { ts: base - HOUR, side: 'buy' },
    { ts: base - 2 * HOUR, side: 'buy' },
  ];
  // even a wild plan cannot exceed cfg.hardMaxTradesPerDay
  const r = validateTrade({ side: 'buy', rmb: 2000, ts: base }, p, quote, cfg, { plan: wild, trades });
  assert.equal(r.ok, false);
});

test('overnight 00:00–02:00 counts toward the previous trading session', () => {
  // Monday 09:10 and 13:10 (2 fills), then Tuesday 01:00 continuation:
  // that is the 3rd market trade of the SAME session -> must be rejected.
  const monMorning = Date.UTC(2026, 10, 2, 1, 10); // Mon 09:10 SH
  const monAfternoon = Date.UTC(2026, 10, 2, 5, 10); // Mon 13:10 SH
  const tueOvernight = Date.UTC(2026, 10, 2, 17, 0); // Tue 01:00 SH
  const trades = [
    { ts: monMorning, side: 'buy' },
    { ts: monAfternoon, side: 'buy' },
  ];
  const r = checkFrequency(trades, { maxTradesPerDay: 2, minIntervalHours: 2 }, tueOvernight);
  assert.equal(r.ok, false, 'overnight continuation must share the session quota');
});

test('stale quote rejects market trades', () => {
  const p = createPortfolio(cfg.initialCapitalRmb);
  const stale = base - 10 * 60_000; // 10 minutes old
  const r = validateTrade({ side: 'buy', rmb: 2000, ts: base }, p, quote, cfg, {
    plan: { maxTradesPerDay: 2, minIntervalHours: 2 }, trades: [],
    quoteTs: stale, quoteMaxAgeSec: 300,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /行情|quote|stale|陈旧/i);
  const fresh = validateTrade({ side: 'buy', rmb: 2000, ts: base }, p, quote, cfg, {
    plan: { maxTradesPerDay: 2, minIntervalHours: 2 }, trades: [],
    quoteTs: base - 30_000, quoteMaxAgeSec: 300,
  });
  assert.equal(fresh.ok, true);
});
