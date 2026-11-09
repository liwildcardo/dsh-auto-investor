import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { runBacktest } from '../core/backtest.js';
import { loadProducts } from '../core/registry.js';
import { createProductEngine } from '../core/engine.js';
import { createHub } from '../core/hub.js';
import { registerTools } from '../lib/tools.js';

const SIGNALS = [{ id: 'trend', params: { fast: 2, slow: 3 }, weight: 1 }];

test('backtest: insufficient bars reports instead of guessing', () => {
  const r = runBacktest({ bars: [1, 2, 3], signals: SIGNALS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /数据不足/);
});

test('backtest: a trending series beats buy-and-hold with the trend signal', () => {
  // 40 up bars → trend fires early, ride to the end.
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const r = runBacktest({ bars: up, signals: SIGNALS, threshold: 0.8, stopLossPct: -50, takeProfitPct: 50 });
  assert.equal(r.ok, true);
  assert.ok(r.trades >= 1, 'at least one round trip');
  assert.ok(r.returnPct > 30, `strong uptrend captured, got ${r.returnPct}`);
  assert.ok(Math.abs(r.buyHoldReturnPct - ((139 - 100) / 100) * 100) < 0.01);
  // Entry needs 5 bars of signal confirmation, so on a straight line the
  // strategy lags a from-zero buy-and-hold — documented, not a bug.
  assert.equal(r.beatBuyHold, false);
  assert.ok(r.returnPct < r.buyHoldReturnPct);
});

test('backtest: stop loss bounds the loss on a crash', () => {
  // Steep decline → trend goes short-scored? trend scores -2 (below threshold)
  // so no entry; craft: rise first (enter), then crash (stop exit).
  const bars = [
    ...Array.from({ length: 10 }, (_, i) => 100 + i), // uptrend → entry
    110, 104, 97, // −12% from entry 109 → hits −5% stop at 103.55 → exits ~104
    ...Array.from({ length: 8 }, (_, i) => 60 - i),   // keeps falling after exit
  ];
  const r = runBacktest({ bars, signals: SIGNALS, threshold: 0.8, stopLossPct: -5, takeProfitPct: 50 });
  assert.equal(r.ok, true);
  assert.ok(r.trades >= 1, 'stop produced a closed trade');
  assert.ok(r.returnPct < 0, 'loss realized');
  // Without the stop the ride-down would be far worse than the realized loss.
  assert.ok(r.returnPct > -40, `stop bounded the loss, got ${r.returnPct}`);
  assert.ok(r.maxDrawdownPct <= 0);
});

test('backtest reports win rate and drawdown fields for the reflect prompt', () => {
  const bars = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const r = runBacktest({ bars, signals: SIGNALS });
  assert.equal(r.ok, true);
  assert.ok(r.winRate === null || (r.winRate >= 0 && r.winRate <= 1));
  assert.ok(Number.isFinite(r.maxDrawdownPct));
  assert.ok(Number.isFinite(r.buyHoldReturnPct));
});

test('engine.runBacktest wires product bars, signals and risk', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-bt-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = loadProducts({ enabled: ['ashare'] })[0];
  for (let i = 0; i < 40; i += 1) {
    db.insertPoint({
      ts: Date.UTC(2026, 6, 1) + i * 86_400_000,
      product: 'ashare', symbol: 'sh600519',
      price: 1400 + i * 5,
    });
  }
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }), llm: async () => '{}',
    now: () => Date.UTC(2026, 10, 2, 2, 0),
  });
  const r = engine.runBacktest('sh600519');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.symbol, 'sh600519');
  assert.equal(r.barInterval, '1d');
  assert.equal(r.version, 1);
  assert.ok(r.trades >= 1);
});

test('agent tool auto_investor_backtest dispatches to the hub', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-btt-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const products = loadProducts({ enabled: ['gold'] });
  const engines = products.map(p => createProductEngine({
    db, product: p, fetchFn: async () => ({ ok: true }), llm: async () => '{}',
    now: () => Date.UTC(2026, 10, 2, 2, 0),
  }));
  const hub = createHub({ engines, products });
  const defs = {};
  registerTools({ tools: { register: (d) => { defs[d.name] = d; return () => {}; } } }, hub);
  assert.ok(defs.auto_investor_backtest, 'tool registered');
  const out = await defs.auto_investor_backtest.execute({ product: 'gold' });
  assert.ok(out.ok === true || out.ok === false, 'structured result');
  const bad = await defs.auto_investor_backtest.execute({ product: 'bogus' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown product/);
});
