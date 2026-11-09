import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { normalizeProduct } from '../core/product.js';
import { createProductEngine } from '../core/engine.js';
import { loadProducts } from '../core/registry.js';

const OPEN = Date.UTC(2026, 10, 6, 2, 0); // Friday 10:00 Shanghai
const DAY = 86_400_000;

function harness(t, { product: productPatch = {}, risk = {}, signals, llm } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-bars-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const state = { price: 10, prevClose: 10, volume: 100 };
  const product = normalizeProduct({
    id: 'bar',
    name: 'BAR',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
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
      indicators: [],
      signals: signals ?? [{ id: 'trend', params: { fast: 2, slow: 3 }, weight: 1 }],
      candidates: { threshold: 0.8 },
      prompt: {},
      decision: {},
      evolvable: [],
      ...(productPatch.strategy ?? {}),
    },
    rules: {
      unit: 'share', lotSize: 100, settlement: 'T+0', fees: {},
      sessions: [[570, 690], [780, 900]], holidays: [],
      ...(productPatch.rules ?? {}),
    },
    risk: { perTrade: 10000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -50, takeProfitPct: 50, dailyLossPct: -99, ...risk },
  });
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 })),
    now: () => OPEN,
  });
  return { engine, db, state, product };
}

test("barsFor '1d' merges daily history and intraday ticks by market-local date", (t) => {
  const { engine, db } = harness(t);
  // One historical daily bar at local midnight + intraday ticks the same day.
  db.insertPoint({ ts: Date.parse('2026-11-05T00:00:00+08:00'), product: 'bar', symbol: 'x', price: 100 });
  db.insertPoint({ ts: Date.parse('2026-11-05T09:00:00+08:00'), product: 'bar', symbol: 'x', price: 101 });
  db.insertPoint({ ts: Date.parse('2026-11-05T10:00:00+08:00'), product: 'bar', symbol: 'x', price: 105 });
  db.insertPoint({ ts: Date.parse('2026-11-06T10:00:00+08:00'), product: 'bar', symbol: 'x', price: 110 });
  const bars = engine.signalBars('x', '1d');
  // Same local date collapses to ONE bar (last price wins) — the old raw-point
  // series would have seen 100,101,105 as three separate "days".
  assert.deepEqual(bars, [105, 110]);
});

test("barsFor '1h' keeps only in-session points (closed hours are static)", (t) => {
  const { engine, db } = harness(t);
  // 08:00 is pre-open for the A-share-like sessions; 10:00 is in-session.
  db.insertPoint({ ts: Date.parse('2026-11-06T08:00:00+08:00'), product: 'bar', symbol: 'x', price: 999 });
  db.insertPoint({ ts: Date.parse('2026-11-06T10:00:00+08:00'), product: 'bar', symbol: 'x', price: 100 });
  db.insertPoint({ ts: Date.parse('2026-11-06T12:30:00+08:00'), product: 'bar', symbol: 'x', price: 998 }); // lunch
  const bars = engine.signalBars('x', '1h');
  assert.deepEqual(bars, [100], 'pre-open and lunch points excluded');
});

test('candidate constraint: buys outside the picked set are rejected', async (t) => {
  // No series at all → trend scores 0 → no candidates → the LLM cannot buy.
  const { engine } = harness(t, {
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 }),
  });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0, JSON.stringify(res));
  assert.match(res.rejection ?? '', /不在候选或持仓/);
});

test('volatility gate: a statistically flat uptrend is refused', async (t) => {
  const { engine, db } = harness(t, {
    risk: { minVolatility: 0.0005 },
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 }),
  });
  // Linear creep ending AT the live quote (10): trend fires (score 2) but σ≈0.
  for (let i = 0; i < 30; i += 1) {
    db.insertPoint({ ts: OPEN - (30 - i) * DAY, product: 'bar', symbol: 'x', price: 10 - (29 - i) * 0.01 });
  }
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 0, JSON.stringify(res));
  assert.match(res.rejection ?? '', /低波动率过滤/);
});

test('products declare bar intervals and volatility floors', () => {
  const by = Object.fromEntries(loadProducts().map(p => [p.id, p]));
  assert.equal(by.gold.strategy.barInterval, '1h');
  assert.equal(by.ashare.strategy.barInterval, '1d');
  assert.equal(by.us.strategy.barInterval, '1h');
  assert.equal(by.hk.strategy.barInterval, '1d');
  for (const id of ['gold', 'ashare', 'us', 'hk']) {
    assert.ok(Number.isFinite(by[id].risk.minVolatility), `${id} has a volatility floor`);
  }
});
