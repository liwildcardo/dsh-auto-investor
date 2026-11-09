import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { normalizeProduct } from '../core/product.js';
import { createProductEngine } from '../core/engine.js';

const OPEN = Date.UTC(2026, 10, 6, 2, 0); // Friday 10:00 Shanghai

function makeProduct(plan, extra = {}) {
  const state = { price: 10, prevClose: 10, volume: 100 };
  return {
    state,
    product: normalizeProduct({
      id: 'freq',
      name: 'FREQ',
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
        signals: [{ id: 'trend' }],
        candidates: { threshold: 0.8 },
        prompt: {},
        decision: {},
        evolvable: [],
        ...(plan !== undefined ? { plan } : {}),
      },
      rules: {
        unit: 'share', lotSize: 100, settlement: 'T+0', fees: {},
        sessions: [[570, 690], [780, 900]], holidays: [],
        ...extra.rules,
      },
      risk: { perTrade: 10000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -50, takeProfitPct: 50, dailyLossPct: -99 },
      ...extra.top,
    }),
    state,
  };
}

function engineFor(t, { plan, llm, clock = () => OPEN, extra = {}, seedVersion = undefined } = {}) {
  const { product, state } = makeProduct(plan, extra);
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-freq-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  if (seedVersion) db.putState(`product:${product.id}:versions`, [seedVersion]);
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: llm ?? (async () => JSON.stringify({ action: 'buy', symbol: 'x', amount: 1000, confidence: 0.9 })),
    now: clock,
  });
  return { engine, state, db };
}

const FULL_DAY = { rules: { sessions: [[570, 1560]] } }; // 9:30–26:00 so all probes stay in-session

test('a version without a plan falls back to the product default (not the loosest limits)', async (t) => {
  // Reproduce the live defect: a legacy fork stored signals/risk but NO plan.
  let clock = OPEN;
  const { engine } = engineFor(t, {
    plan: undefined,
    clock: () => clock,
    extra: FULL_DAY,
    seedVersion: { id: 1, createdAt: 1, strategy: { signals: [{ id: 'trend' }], risk: {} }, startPnl: 0 },
  });
  const r1 = await engine.runCycle();
  assert.equal(r1.trades.length, 1, `first buy: ${JSON.stringify(r1)}`);
  // Second buy right away must be blocked by the default 4h interval.
  clock += 60_000;
  const r2 = await engine.runCycle();
  assert.equal(r2.trades.length, 0, 'interval gate must apply');
  assert.match(r2.rejection ?? '', /最小交易间隔/);
  // After 4h a second buy of the day is allowed (default cap is 2/day).
  clock += 4 * 3600_000 + 60_000;
  const r3 = await engine.runCycle();
  assert.equal(r3.trades.length, 1, 'after the interval a buy is allowed');
  // Third: daily cap (2/day) now reached.
  clock += 4 * 3600_000 + 60_000;
  const r4 = await engine.runCycle();
  assert.equal(r4.trades.length, 0, 'daily cap from the default plan');
  assert.match(r4.rejection ?? '', /每日交易上限\(2\)/);
});

test('hard caps bound a permissive version plan (10/day, 0 gap → 3/day, 2h)', async (t) => {
  let clock = OPEN;
  const { engine } = engineFor(t, {
    plan: { style: 'swing', maxTradesPerDay: 10, minIntervalHours: 0, maxPositionPct: 60 },
    clock: () => clock,
    extra: FULL_DAY,
  });
  const r1 = await engine.runCycle();
  assert.equal(r1.trades.length, 1);
  // gap 0 in plan, but hard minimum 2h must hold.
  clock += 60_000;
  const r2 = await engine.runCycle();
  assert.equal(r2.trades.length, 0, 'hard 2h floor overrides plan gap 0');
  assert.match(r2.rejection ?? '', /最小交易间隔/);
  clock += 2 * 3600_000 + 60_000;
  const r3 = await engine.runCycle();
  assert.equal(r3.trades.length, 1);
  clock += 2 * 3600_000 + 60_000;
  const r4 = await engine.runCycle();
  assert.equal(r4.trades.length, 1, 'third trade of the day allowed under hard cap 3');
  clock += 2 * 3600_000 + 60_000;
  const r5 = await engine.runCycle();
  assert.equal(r5.trades.length, 0, 'hard ceiling 3/day blocks the fourth');
  assert.match(r5.rejection ?? '', /每日交易上限\(3\)/);
});

test('normalizeVersions backfills a missing plan from the product default', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-fplan-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  db.putState('product:freq:versions', [{ id: 1, createdAt: 1, strategy: { signals: [{ id: 'trend' }], risk: {} }, startPnl: 0 }]);
  const { product } = makeProduct(undefined);
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }), llm: async () => '{}', now: () => OPEN,
  });
  const v = engine.status().currentVersion;
  assert.equal(v.strategy.plan?.maxTradesPerDay, 2, 'product default plan restored');
  assert.equal(v.strategy.plan?.minIntervalHours, 4);
});
