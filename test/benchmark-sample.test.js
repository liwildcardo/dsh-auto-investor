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

function harness(t, { llm, risk = {}, seedFills = 0 } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-bench-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const state = { price: 10, prevClose: 10, volume: 100 };
  const product = normalizeProduct({
    id: 'bench', name: 'BENCH', currency: 'CNY', timezone: 'Asia/Shanghai',
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
    risk: { perTrade: 10000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -5, takeProfitPct: 50, dailyLossPct: -99, ...risk },
  });
  // Candidate bars so entries pass the candidate gate.
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'bench', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  for (let i = 0; i < seedFills; i += 1) {
    db.insertTrade({ ts: OPEN + 1000 + i, side: 'sell', grams: 0, price: 10, rmb: 1000, product: 'bench', symbol: 'x', realized: 1 });
  }
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 })),
    now: () => OPEN,
  });
  return { engine, db, state };
}

test('buy-and-hold benchmark seeds at the first fill and tracks relative return', async (t) => {
  const { engine, state } = harness(t, {
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 }),
  });
  assert.equal(engine.status().benchmark, null, 'no benchmark before any fill');
  const buy = await engine.runCycle();
  assert.equal(buy.trades.length, 1, JSON.stringify(buy));
  const b0 = engine.status().benchmark;
  assert.equal(b0.symbol, 'x');
  assert.ok(Math.abs(b0.returnPct) < 1e-9, 'zero return at the entry price');
  state.price = 11; // +10% since the first fill
  await engine.tick();
  const b1 = engine.status().benchmark;
  assert.ok(Math.abs(b1.returnPct - 10) < 1e-9, `benchmark +10%, got ${b1.returnPct}`);
  // The reflection stats carry the benchmark so the model judges alpha.
  const r = await engine.reflectIfDue({ force: true });
  assert.ok(Math.abs(r.stats.benchmarkReturnPct - 10) < 1e-9, 'reflect stats include the benchmark');
});

test('parameter evolution waits for a minimum trade sample', async (t) => {
  const reflectLlm = async () => JSON.stringify({ critique: '收紧止损', params: { 'risk.stopLossPct': -4.5 } });
  // Default floor is 5 fills (product.js DEFAULTS).
  const noSamples = harness(t, { llm: reflectLlm });
  const r1 = await noSamples.engine.reflectIfDue({ force: true });
  assert.deepEqual(r1.applied, {}, 'no tuning below the sample floor');
  assert.equal(r1.versionCreated, false, 'no fork for tuning without samples');
  assert.ok(r1.critique, 'critique is still recorded');

  const withSamples = harness(t, { llm: reflectLlm, seedFills: 5 });
  const r2 = await withSamples.engine.reflectIfDue({ force: true });
  assert.equal(r2.applied['risk.stopLossPct'], -4.5, 'tuning allowed once the floor is met');
  assert.equal(r2.versionCreated, true);
});
