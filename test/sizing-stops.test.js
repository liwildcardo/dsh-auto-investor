import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { normalizeProduct } from '../core/product.js';
import { createProductEngine } from '../core/engine.js';

const OPEN = Date.UTC(2026, 10, 6, 2, 0);
const DAY = 86_400_000;

function harness(t, { risk = {}, llm, clock = () => OPEN } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-sizing-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const state = { price: 10, prevClose: 10, volume: 100 };
  const product = normalizeProduct({
    id: 'size', name: 'SIZE', currency: 'CNY', timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: {
      kind: 'multi',
      async quote() {
        return { ts: Date.now(), currency: 'CNY', quotes: [{ symbol: 'x', price: state.price, prevClose: state.prevClose, open: 10, volume: state.volume }] };
      },
    },
    universe: { watchlist: () => [{ symbol: 'x', name: 'X' }], lotSize: 100 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: {
      signals: [{ id: 'trend', params: { fast: 2, slow: 3 }, weight: 1 }],
      candidates: { threshold: 0.8 },
      prompt: {}, decision: {},
      evolvable: [{ path: 'risk.stopLossPct', min: -12, max: -1, step: 0.5 }],
    },
    rules: { unit: 'share', lotSize: 100, settlement: 'T+0', fees: {}, sessions: [[570, 1560]], holidays: [] },
    risk: { perTrade: 100000, perSymbolPct: 100, minConfidence: 0.5, dailyLossPct: -99, stopLossPct: -10, takeProfitPct: 50, ...risk },
  });
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'size', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: llm ?? (async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 999999, confidence: 0.9 })),
    now: clock,
  });
  return { engine, db, state, product };
}

test('risk-budget sizing: notional = capital × risk% ÷ stop distance', async (t) => {
  // 0.5% of 100k = 500元 risk ÷ 10% stop = 5000元 notional (amount/perTrade ignored).
  const { engine } = harness(t, {});
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.ok(Math.abs(res.trades[0].notional - 5000) < 1, `notional 5000, got ${res.trades[0].notional}`);
});

test('risk budget shrinks automatically when the stop widens', async (t) => {
  // Same 0.5% risk, but a −20% stop → budget 2500 → floored to 200 shares (2000).
  const { engine } = harness(t, { risk: { stopLossPct: -20 } });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.equal(res.trades[0].qty, 200, 'lot-floored budget quantity');
  assert.ok(res.trades[0].notional <= 2500 + 1e-6, `notional within budget, got ${res.trades[0].notional}`);
});

test('a budget below one lot falls back to the smallest capped position', async (t) => {
  // 0.1% risk ÷ 50% stop = 20元 budget → rounds to 0 lots; the per-trade cap
  // (100000) still allows one 100-share lot at 10元.
  const { engine } = harness(t, { risk: { riskPerTradePct: 0.001, stopLossPct: -50 } });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.equal(res.trades[0].qty, 100, 'one lot taken');
});

test('trailing stop locks profits from the peak (in-profit only)', async (t) => {
  let action = { action: 'buy', symbol: 'x', amount: 5000, confidence: 0.9 };
  const { engine, state } = harness(t, { risk: { trailingStopPct: 3, stopLossPct: -50 }, llm: async () => JSON.stringify(action) });
  await engine.runCycle();
  state.price = 12; // +20% → peak 12, in profit
  action = { action: 'hold', confidence: 0.6 };
  await engine.runCycle(); // risk check observes the peak
  state.price = 11.5; // −4.2% from peak, still above cost → trail fires
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.match(res.decision.reason, /trailing-stop|风控触发：trailing/);
});

test('trailing stop does NOT fire while underwater (regular stop handles that)', async (t) => {
  let action = { action: 'buy', symbol: 'x', amount: 5000, confidence: 0.9 };
  const { engine, state } = harness(t, { risk: { trailingStopPct: 3, stopLossPct: -50 }, llm: async () => JSON.stringify(action) });
  await engine.runCycle();
  state.price = 9.5; // below cost, peak = 10 (entry) → −5% from peak would trip a naive trail
  action = { action: 'hold', confidence: 0.6 };
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0, `no exit while underwater: ${JSON.stringify(res)}`);
});

test('time stop exits a losing position held past maxHoldHours', async (t) => {
  let clock = OPEN;
  let action = { action: 'buy', symbol: 'x', amount: 5000, confidence: 0.9 };
  const { engine, state } = harness(t, {
    risk: { maxHoldHours: 24, stopLossPct: -50 },
    llm: async () => JSON.stringify(action),
    clock: () => clock,
  });
  await engine.runCycle();
  state.price = 9.8; // losing position
  action = { action: 'hold', confidence: 0.6 };
  clock += 72 * 3600_000; // jump to Monday 10:00 (weekend is closed; next session)
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.match(res.decision.reason, /time-stop|风控触发：time/);
});

test('LLM horizonHours survives parsing (was silently dropped)', async (t) => {
  const { engine, db } = harness(t, {
    llm: async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6, horizonHours: 48 }),
  });
  await engine.runCycle();
  const journal = db.getState('product:size:decisions') ?? [];
  assert.equal(journal.length, 1, 'decision journaled');
  assert.equal(journal[0].decision.horizonHours, 48, 'horizon preserved for review');
  assert.ok(Array.isArray(journal[0].signals), 'signal snapshot journaled (C3)');
});
