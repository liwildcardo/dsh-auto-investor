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
const DAY = 86_400_000;

/**
 * Ascending daily signal bars ending at the live quote (10): the trend signal
 * then scores +2, the entry gate sees a candidate, and buys are executable.
 */
function seedTrend(db, { product, symbol, count = 25, endPrice = 10, step = 0.01 }) {
  for (let i = 0; i < count; i += 1) {
    db.insertPoint({
      ts: OPEN - (count - i) * DAY,
      product, symbol,
      price: endPrice - (count - 1 - i) * step,
    });
  }
}

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
      plan: { maxTradesPerDay: 3, minIntervalHours: 0, maxPositionPct: 40 },
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
      ...(overrides.rules ?? {}),
    },
    risk: { perTrade: 10000, perSymbolPct: 25, dailyLossPct: -50, stopLossPct: -5, takeProfitPct: 10, minConfidence: 0.55 },
  });
  return { product, state };
}

function makeEngine(t, { llm, clock = () => OPEN, settlement, rules } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-eng-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const { product, state } = makeProduct({ settlement, rules });
  seedTrend(db, { product: product.id, symbol: 'x' });
  seedTrend(db, { product: product.id, symbol: 'y' });
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
    params: { 'signals.trend.params.slow': 25, 'risk.perTrade': 999999 },
  });
  const { engine } = makeEngine(t, { llm: async () => llmOut });
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.reflected, true);
  assert.equal(r.versionCreated, true);
  assert.equal(r.applied['signals.trend.params.slow'], 25, 'within the 20%/2-step budget');
  assert.equal(r.applied['risk.perTrade'], undefined, 'non-whitelisted path ignored');
  assert.equal(engine.status().versions.length, 2);
  assert.equal(engine.status().versions[1].strategy.signals[0].params.slow, 25);
  assert.equal(engine.status().versions[1].strategy.plan?.maxTradesPerDay, 3, 'untouched plan survives the fork');
});

test('reflection rejects an over-large parameter jump (anti-overfit)', async (t) => {
  const llmOut = JSON.stringify({ critique: 'x', params: { 'signals.trend.params.slow': 60 } });
  const { engine } = makeEngine(t, { llm: async () => llmOut });
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.applied['signals.trend.params.slow'], undefined, '20→60 is beyond the allowed jump');
  assert.equal(r.versionCreated, false);
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
  const reflectOut = JSON.stringify({ critique: '收紧止损', params: { 'risk.stopLossPct': -4 } });
  let llmOut = JSON.stringify(action);
  const { engine, state } = makeEngine(t, { llm: async () => llmOut, settlement: 'T+0' });
  await engine.runCycle();
  llmOut = reflectOut;
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.applied['risk.stopLossPct'], -4, 'risk param applied');
  llmOut = JSON.stringify({ action: 'hold', confidence: 0.6 });
  state.price = 9.5; // -5% vs 10 → beyond the evolved -4% stop
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.match(res.decision.reason, /风控/);
});

test('per-symbol and total exposure caps are independent', async (t) => {
  // Full-day session so the 2h hard buy-gap fits inside trading hours.
  let clock = OPEN;
  const { engine } = makeEngine(t, {
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 10000, confidence: 0.9 }),
    clock: () => clock,
    rules: { sessions: [[570, 1560]] },
  });
  assert.equal((await engine.runCycle()).trades.length, 1, 'first fill within the per-symbol cap');
  clock += 2 * 3600_000 + 60_000;
  assert.equal((await engine.runCycle()).trades.length, 1, 'second fill still under 25%');
  clock += 2 * 3600_000 + 60_000;
  const third = await engine.runCycle();
  assert.equal(third.trades.length, 0, 'third fill would exceed the per-symbol cap');
  assert.match(third.rejection ?? '', /单标的敞口/);
});

test('single product keys day-open by the position symbol (today pnl non-zero)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-dok-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const state = { price: 885 };
  const product = normalizeProduct({
    id: 'goldx', name: 'GOLDX', currency: 'CNY', timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: {
      kind: 'single',
      async quote() {
        const p = state.price;
        return { price: p, buy: p + 2.5, sell: p - 2.5, ts: Date.now(), currency: 'CNY' };
      },
    },
    universe: { watchlist: () => [{ symbol: 'AU9999', name: '黄金', lot: 1 }], lotSize: 1 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: {
      indicators: [], signals: [{ id: 'trend', params: { fast: 2, slow: 3 } }],
      candidates: { threshold: 0.8 }, plan: {}, prompt: {}, decision: {}, evolvable: [],
    },
    rules: { unit: 'gram', lotSize: 1, settlement: 'T+0', fees: {}, sessions: [[550, 1560]], holidays: [] },
    risk: { perTrade: 5000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -50, takeProfitPct: 50, dailyLossPct: -99 },
  });
  // Prior-day ticks: ascending trend so the entry gate has a candidate; kept
  // off TODAY so the day-open baseline stays the 10:00 session tick.
  for (let k = 5; k >= 1; k -= 1) {
    const ts = OPEN - k * DAY;
    const p = 885 - k;
    db.insertTick({ ts, mid: p, price: p, buy: p, sell: p, product: 'goldx' });
  }
  let llmOut = JSON.stringify({ action: 'buy', symbol: 'AU9999', amount: 5000, confidence: 0.9 });
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => llmOut, now: () => OPEN, // Friday 10:00 Shanghai, session open
  });
  await engine.runCycle(); // records day-open at 885 under AU9999, buys
  const qty = engine.snapshot().positions[0].qty;
  assert.ok(qty > 0, 'position opened');
  state.price = 895; // +10 from the session open
  llmOut = JSON.stringify({ action: 'hold', confidence: 0.6 });
  await engine.runCycle();
  const snap = engine.snapshot();
  assert.ok(Math.abs(snap.todayPnl - 10 * qty) < 0.01,
    `today pnl = (895-885)×qty, got ${snap.todayPnl}`);
});

test('day-open is not recorded while the session is closed', async (t) => {
  const { engine, db } = makeEngine(t, { clock: () => LUNCH }); // A-share lunch break
  await engine.tick();
  assert.equal(db.getState('product:test:dayOpen:2026-11-06'), null,
    'closed session must not create a day-open baseline');
});

test('legacy numeric day-open baseline is re-resolved from session history', async (t) => {
  const { engine, db, state } = makeEngine(t, { clock: () => OPEN }); // 10:00, session open
  // Legacy format recorded a stale closed-market price under the symbol.
  db.putState('product:test:dayOpen:2026-11-06', { x: 999 });
  // True session open (first tick after 09:30) already exists in history.
  db.insertPoint({ ts: OPEN + 60_000, product: 'test', symbol: 'x', price: 4090, volume: 1 });
  await engine.tick();
  const rec = db.getState('product:test:dayOpen:2026-11-06');
  assert.equal(typeof rec.x, 'object', 'baseline upgraded to the trusted shape');
  assert.equal(rec.x.price, 4090, 're-resolved from the first in-session tick');
  assert.equal(state.price, 10, 'quote untouched by the probe');
});

test('close statistics feed the reflection (win rate, drawdown)', async (t) => {
  let action = { action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 };
  let price = 10;
  const { engine, state } = makeEngine(t, { llm: async () => JSON.stringify(action), settlement: 'T+0' });
  await engine.runCycle(); // buy at 10
  state.price = 11;        // +10%
  action = { action: 'sell', symbol: 'x', confidence: 0.9 };
  await engine.runCycle(); // sell at 11 → realized gain
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.stats.closes, 1, JSON.stringify(r.stats));
  assert.equal(r.stats.wins, 1);
  assert.equal(r.stats.winRate, 1);
  assert.ok(r.stats.realizedPnl > 0);
  assert.ok(r.stats.maxDrawdownPnl <= 0);
});

test('non-CNY products report a CNY conversion rate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-fx-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = normalizeProduct({
    id: 'usx', name: 'USX', currency: 'USD', timezone: 'America/New_York',
    market: {
      kind: 'multi', fx: 'USDCNY',
      async quote() {
        return { ts: Date.now(), currency: 'USD', quotes: [{ symbol: 'usX', price: 10, prevClose: 10, open: 10, volume: 1 }] };
      },
    },
    universe: { watchlist: () => [{ symbol: 'usX', name: 'X', lot: 1 }], lotSize: 1 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: { indicators: [], signals: [{ id: 'trend' }], candidates: { threshold: 0.8 }, prompt: {}, decision: {}, evolvable: [] },
    rules: { unit: 'share', lotSize: 1, settlement: 'T+1', allowSameDaySell: true, fees: {}, sessions: [[570, 960]], holidays: [] },
    risk: { perTrade: 1000, perSymbolPct: 25, minConfidence: 0.5, stopLossPct: -5, takeProfitPct: 10 },
  });
  const fetchFn = async (url) => {
    if (String(url).includes('er-api')) return { ok: true, json: async () => ({ rates: { CNY: 7.2 } }) };
    return { ok: true, json: async () => ({ data: {} }) };
  };
  const engine = createProductEngine({ db, product, fetchFn, llm: async () => '{}', now: () => Date.UTC(2026, 10, 2, 15, 0) });
  await engine.tick();
  const st = engine.status();
  assert.ok(Math.abs(st.fx.rate - 7.2) < 1e-9, 'USD→CNY rate reported for display');
});

test('migrated versions with empty signals/risk are backfilled from the product', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-migv-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  db.putState('product:test:versions', [{ id: 1, createdAt: 1, strategy: { signals: [], risk: {} }, startPnl: 0 }]);
  const { product } = makeProduct();
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ critique: 'x', params: { 'risk.stopLossPct': -4.5 } }),
    now: () => OPEN,
  });
  const st = engine.status();
  assert.ok(st.currentVersion.strategy.signals.length > 0, 'signals backfilled from the product');
  assert.ok(Object.keys(st.currentVersion.strategy.risk).length > 0, 'risk backfilled');
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.applied['risk.stopLossPct'], -4.5, 'whitelisted path applies to the backfilled version');
  assert.equal(r.versionCreated, true);
});

test('total-drawdown circuit breaker blocks new trades', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-breaker-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const state = { price: 10 };
  const product = normalizeProduct({
    id: 'brk', name: 'BRK', currency: 'CNY', timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: {
      kind: 'multi',
      async quote() {
        return { ts: Date.now(), currency: 'CNY', quotes: [{ symbol: 'x', price: state.price, prevClose: 10, open: 10, volume: 1 }] };
      },
    },
    universe: { watchlist: () => [{ symbol: 'x', name: 'X' }], lotSize: 100 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: { indicators: [], signals: [{ id: 'trend' }], candidates: { threshold: 0.8 }, plan: {}, prompt: {}, decision: {}, evolvable: [] },
    rules: { unit: 'share', lotSize: 100, settlement: 'T+0', fees: {}, sessions: [[570, 690]], holidays: [] },
    risk: { perTrade: 60000, perSymbolPct: 100, circuitBreakerPct: -10, minConfidence: 0.5, stopLossPct: -50, takeProfitPct: 50 },
  });
  let llmOut = JSON.stringify({ action: 'buy', symbol: 'x', amount: 50000, confidence: 0.9 });
  seedTrend(db, { product: 'brk', symbol: 'x' }); // candidate bars for the first entry
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => llmOut, now: () => OPEN,
  });
  await engine.runCycle();
  state.price = 8; // -20% on a 50k position → -10% account drawdown
  llmOut = JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 });
  const res = await engine.runCycle();
  assert.equal(res.circuitBreaker, true, JSON.stringify(res));
  assert.equal(res.trades.length, 0);
  assert.match(res.decision.reason, /熔断/);
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
