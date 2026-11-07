import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { normalizeProduct } from '../core/product.js';
import { createProductEngine } from '../core/engine.js';

// 2026-11-06 Friday 10:00 Shanghai
const OPEN = Date.UTC(2026, 10, 6, 2, 0);
const LUNCH = Date.UTC(2026, 10, 6, 4, 0);

function makeProduct(overrides = {}) {
  const state = { price: 10, prevClose: 10, volume: 100 };
  const product = normalizeProduct({
    id: 'test',
    name: '测试',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: {
      kind: 'multi',
      async quote() {
        return {
          ts: Date.now(),
          currency: 'CNY',
          quotes: [
            { symbol: 'x', price: state.price, prevClose: state.prevClose, open: 10, volume: state.volume },
            { symbol: 'y', price: state.price, prevClose: state.prevClose, open: 10, volume: state.volume },
          ],
        };
      },
    },
    universe: { watchlist: () => [{ symbol: 'x', name: 'X' }, { symbol: 'y', name: 'Y' }], lotSize: 100 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: {
      indicators: [],
      signals: [{ id: 'trend', params: { fast: 5, slow: 20 }, weight: 1 }],
      candidates: { threshold: 0.8 },
      prompt: { role: 't', heuristics: [], constraints: [] },
      decision: { actions: ['buy', 'sell', 'hold'], shape: 'symbol+shares' },
      evolvable: [
        { path: 'signals.trend.params.slow', min: 10, max: 60, step: 5 },
        { path: 'risk.stopLossPct', min: -12, max: -1, step: 0.5 },
      ],
    },
    rules: {
      unit: 'share', lotSize: 100, settlement: overrides.settlement ?? 'T+1',
      fees: { commissionRate: 0.00025, commissionMin: 5 },
      priceLimit: 10, boardLimitPct: 10,
      sessions: [[570, 690], [780, 900]], holidays: [],
    },
    risk: { perTrade: 10000, perSymbolPct: 25, dailyLossPct: -50, stopLossPct: -5, takeProfitPct: 10, minConfidence: 0.55 },
  });
  return { product, state };
}

function makeEngine(t, { llm, clock = () => OPEN, settlement } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-eng-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const { product, state } = makeProduct({ settlement });
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 })),
    now: clock,
  });
  return { engine, state, db };
}

test('buy fills at the quote price with fees and records a product trade', async (t) => {
  const { engine } = makeEngine(t, { llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9, reason: '趋势向上' }) });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, `trades: ${JSON.stringify(res)}`);
  const snap = engine.snapshot();
  assert.equal(snap.positions[0].qty, 100);
  assert.equal(snap.cash, 100000 - 1000 - 5);
  const trades = engine.status().trades;
  assert.equal(trades.length, 1);
  assert.equal(trades[0].product, 'test');
  assert.equal(trades[0].symbol, 'x');
});

test('T+1 settlement blocks a same-day sell', async (t) => {
  let action = { action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 };
  const { engine } = makeEngine(t, { llm: async () => JSON.stringify(action) });
  await engine.runCycle();
  action = { action: 'sell', symbol: 'x', confidence: 0.9 };
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0);
  assert.match(res.rejection ?? '', /settlement|间隔|上限|时段/);
});

test('next trading day allows the sell', async (t) => {
  let clockNow = OPEN;
  let action = { action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 };
  const { engine } = makeEngine(t, { llm: async () => JSON.stringify(action), clock: () => clockNow });
  await engine.runCycle();
  clockNow = Date.UTC(2026, 10, 9, 2, 0); // Monday 10:00
  action = { action: 'sell', symbol: 'x', confidence: 0.9 };
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.equal(res.trades[0].side, 'sell');
});

test('price limit band rejects an out-of-band fill', async (t) => {
  const { engine, state } = makeEngine(t, { llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 }) });
  state.price = 12; // +20% vs prevClose 10, beyond ±10%
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0);
  assert.match(res.rejection ?? '', /涨跌停/);
});

test('low confidence never trades', async (t) => {
  const { engine } = makeEngine(t, { llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.3 }) });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0);
  assert.match(res.decision.reason, /置信度/);
});

test('closed session rejects the fill', async (t) => {
  const { engine } = makeEngine(t, { llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 }), clock: () => LUNCH });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0);
  assert.match(res.rejection ?? '', /交易时段/);
});

test('reflection applies only whitelisted, clamped parameters and forks a version', async (t) => {
  const llmOut = JSON.stringify({
    critique: '趋势参数偏慢，需缩短',
    params: { 'signals.trend.params.slow': 200, 'risk.perTrade': 999999 },
  });
  const { engine } = makeEngine(t, { llm: async () => llmOut });
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.reflected, true);
  assert.equal(r.versionCreated, true);
  assert.equal(r.applied['signals.trend.params.slow'], 60, 'clamped to the whitelist max');
  assert.equal(r.applied['risk.perTrade'], undefined, 'non-whitelisted path ignored');
  assert.equal(engine.status().versions.length, 2);
  assert.equal(engine.status().versions[1].strategy.signals[0].params.slow, 60);
});

test('explicit qty is floored to the product lot size', async (t) => {
  const { engine } = makeEngine(t, {
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', qty: 150, confidence: 0.9 }),
  });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.equal(res.trades[0].qty, 100, '150 shares → one 100-share lot');
});

test('evolved risk parameters drive the stop-loss gate', async (t) => {
  let action = { action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 };
  const reflectOut = JSON.stringify({ critique: '收紧止损', params: { 'risk.stopLossPct': -1 } });
  let llmOut = JSON.stringify(action);
  const { engine, state } = makeEngine(t, { llm: async () => llmOut, settlement: 'T+0' });
  await engine.runCycle();
  llmOut = reflectOut;
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.applied['risk.stopLossPct'], -1, 'risk param applied');
  llmOut = JSON.stringify({ action: 'hold', confidence: 0.6 });
  state.price = 9.8; // -2% vs 10 → beyond the evolved -1% stop
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.match(res.decision.reason, /风控/);
});

test('per-symbol and total exposure caps are independent', async (t) => {
  const { engine } = makeEngine(t, {
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 10000, confidence: 0.9 }),
  });
  assert.equal((await engine.runCycle()).trades.length, 1, 'first fill within the per-symbol cap');
  assert.equal((await engine.runCycle()).trades.length, 1, 'second fill still under 25%');
  const third = await engine.runCycle();
  assert.equal(third.trades.length, 0, 'third fill would exceed the per-symbol cap');
  assert.match(third.rejection ?? '', /单标的敞口/);
});

test('migrated versions with empty signals/risk are backfilled from the product', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-migv-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  db.putState('product:test:versions', [{ id: 1, createdAt: 1, strategy: { signals: [], risk: {} }, startPnl: 0 }]);
  const { product } = makeProduct();
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ critique: 'x', params: { 'risk.stopLossPct': -2 } }),
    now: () => OPEN,
  });
  const st = engine.status();
  assert.ok(st.currentVersion.strategy.signals.length > 0, 'signals backfilled from the product');
  assert.ok(Object.keys(st.currentVersion.strategy.risk).length > 0, 'risk backfilled');
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.applied['risk.stopLossPct'], -2, 'whitelisted path applies to the backfilled version');
  assert.equal(r.versionCreated, true);
});

test('stop loss forces a sell on the next cycle (T+0 product)', async (t) => {
  let action = { action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 };
  const { engine, state } = makeEngine(t, { llm: async () => JSON.stringify(action), settlement: 'T+0' });
  await engine.runCycle();
  assert.equal(engine.snapshot().positions.length, 1);
  state.price = 9.4; // -6% vs cost 10, beyond the -5% stop
  action = { action: 'hold', confidence: 0.6 };
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.equal(res.trades[0].side, 'sell');
  assert.match(res.decision.reason, /风控/);
});
