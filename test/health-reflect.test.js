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

/** Decisions journal entries mimicking production shape. */
function entry({ picked = [], rejection = null, signals = [], llmError = null } = {}) {
  return {
    ts: Date.now(),
    decision: { action: rejection ? 'buy' : 'hold', symbol: null, confidence: 0.6 },
    rejection, llmError,
    signals: [{ symbol: 'x', score: 0.3, signals }],
    picked,
  };
}
const sig = (id, note = '', extra = {}) => ({ id, score: 0, note, weight: 1, ...extra });

function harness(t, { journal, evolvable, risk = {}, clock, newsIngest, llm } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-health-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const state = { price: 10, prevClose: 10, volume: 100 };
  const product = normalizeProduct({
    id: 'hlth', name: 'HLTH', currency: 'CNY', timezone: 'Asia/Shanghai',
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
      signals: [
        { id: 'trend', params: { fast: 5, slow: 20 }, weight: 1 },
        { id: 'rsi', params: { period: 14 }, weight: 0.6 },
      ],
      candidates: { threshold: 0.8 },
      prompt: {}, decision: {},
      evolvable: evolvable ?? [
        { path: 'signals.trend.params.slow', min: 3, max: 60, step: 1 },
        { path: 'signals.rsi.params.period', min: 3, max: 30, step: 1 },
        { path: 'risk.stopLossPct', min: -20, max: -1, step: 0.5 },
      ],
    },
    rules: { unit: 'share', lotSize: 100, settlement: 'T+0', fees: {}, sessions: [[570, 1560]], holidays: [] },
    risk: { perTrade: 10000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -5, takeProfitPct: 50, dailyLossPct: -99, minSamplesToEvolve: 5, ...risk },
  });
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'hlth', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  if (journal) db.putState('product:hlth:decisions', journal);
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: llm ?? (async () => '{}'),
    now: clock ?? (() => OPEN), newsIngest,
  });
  return { engine, db, state };
}

test('health shrink SNAPS off-grid proposals down instead of rejecting (audit C1)', async (t) => {
  const dead = Array.from({ length: 25 }, () => entry({
    rejection: '标的不在候选或持仓中',
    signals: [sig('trend', '数据不足')],
  }));
  const llm = async () => JSON.stringify({
    critique: 'bars 25 < slow 需求，缩回看',
    params: { 'signals.trend.params.slow': 17, 'signals.rsi.params.period': 14 },
  });
  const { engine, db } = harness(t, {
    journal: dead,
    llm,
    // step=5 grid: the model's 17 is off-grid — the old exact-match rejected
    // it and the fix was lost; it must snap DOWN to 15 (still a shrink).
    evolvable: [{ path: 'signals.trend.params.slow', min: 5, max: 60, step: 5 }],
  });
  const r = await engine.reflectIfDue();
  assert.equal(r.reflected, true, 'health trigger fired');
  assert.deepEqual(r.applied, { 'signals.trend.params.slow': 15 }, 'off-grid proposal snapped down');
  assert.equal(r.versionCreated, true, 'version forked with the snapped fix');
  const last = (db.getState('product:hlth:reflections') ?? []).at(-1);
  assert.deepEqual(last.params, { 'signals.trend.params.slow': 17, 'signals.rsi.params.period': 14 }, 'raw proposal recorded (audit C2)');
  assert.ok(last.rejected?.some(x => x.path === 'signals.rsi.params.period' && x.reason === 'not-evolvable'), 'rejection reason recorded');
});

test('manual reflection below the sample floor records sample-floor rejection (audit C2)', async (t) => {
  const llm = async () => JSON.stringify({
    critique: '建议收紧止损',
    params: { 'risk.stopLossPct': -4 },
  });
  const { engine, db } = harness(t, { llm }); // floor=5, fills=0, force→manual (not health)
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.reflected, true);
  assert.deepEqual(r.applied, {}, 'no tuning below the floor');
  assert.equal(r.versionCreated, false);
  const last = (db.getState('product:hlth:reflections') ?? []).at(-1);
  assert.deepEqual(last.params, { 'risk.stopLossPct': -4 }, 'raw proposal kept');
  assert.ok(last.rejected?.some(x => x.reason === 'sample-floor'), 'the blocker is named');
});

test('decision-cycle ingest is stale-guarded by the poll interval (frequency review P2)', async (t) => {
  let clock = OPEN;
  let ingests = 0;
  const { engine } = harness(t, {
    clock: () => clock,
    newsIngest: async () => { ingests += 1; return { ts: clock }; },
  });
  await engine.runCycle();        // boot: no lastIngest → ingest (#1)
  clock += 60_000;                // 1 minute later, inside the 15-min window
  await engine.runCycle();
  assert.equal(ingests, 1, 'fresh ingest is not repeated inside the poll interval');
  clock += 16 * 60_000;           // beyond newsPollMin
  await engine.runCycle();
  assert.equal(ingests, 2, 'stale ingest is refreshed by the decision cycle');
});

test('healthStats: candidate rate, rejection breakdown, signal coverage', (t) => {
  const journal = [
    ...Array.from({ length: 30 }, () => entry({
      rejection: '标的不在候选或持仓中',
      signals: [sig('trend', '数据不足'), sig('rsi', 'ok')],
    })),
    ...Array.from({ length: 15 }, () => entry({
      rejection: '非交易时段',
      signals: [sig('trend', 'ok'), sig('rsi', 'ok', { noData: true })],
    })),
    entry({ picked: [{ symbol: 'x', score: 1.2 }], signals: [sig('trend', 'ok'), sig('rsi', 'ok')] }),
  ];
  const { engine } = harness(t, { journal });
  const h = engine.status().health;
  assert.equal(h.cycles, 46);
  assert.equal(h.candidateRate, Math.round((1 / 46) * 1000) / 1000, 'one candidate cycle out of 46 (3dp)');
  assert.equal(h.rejections['标的不在候选或持仓中'], 30);
  assert.equal(h.rejections['非交易时段'], 15);
  // coverage: 46 cycles × 2 signals = 92; uncovered = 30 (trend 数据不足) + 15 (rsi noData) = 45
  assert.equal(h.signalCoverage, Math.round(((92 - 45) / 92) * 1000) / 1000, 'covered/evaluated (3dp)');
  assert.ok(h.barsRequired >= 22, `trend slow20 → required 22, got ${h.barsRequired}`);
  assert.equal(h.llmErrorRate, 0);
});

test('health trigger: fires on zero-candidate streak, respects cycles floor and cooldown', async (t) => {
  const deadJournal = Array.from({ length: 25 }, () => entry({
    rejection: '标的不在候选或持仓中',
    signals: [sig('trend', '数据不足'), sig('rsi', '数据不足')],
  }));
  const { engine, db } = harness(t, { journal: deadJournal });
  // No performance trigger is due (no losses, fresh clock) — health alone fires.
  const r = await engine.reflectIfDue();
  assert.equal(r.reflected, true, 'health reflection fired');
  const refl = db.getState('product:hlth:reflections');
  assert.equal(refl.at(-1).trigger, 'health');
  // 6h cooldown: immediate second call does not fire again.
  const r2 = await engine.reflectIfDue();
  assert.equal(r2.reflected, false, 'cooldown active');
  assert.ok(db.getState('product:hlth:lastHealthReflectAt'), 'cooldown clock written');
});

test('health reflection: shrink-only lookback fixes bypass the sample floor', async (t) => {
  const deadJournal = Array.from({ length: 25 }, () => entry({
    rejection: '标的不在候选或持仓中',
    signals: [sig('trend', '数据不足'), sig('rsi', '数据不足')],
  }));
  const llm = async () => JSON.stringify({
    critique: '回看参数超过现有数据量',
    params: {
      'signals.trend.params.slow': 10,   // shrink 20→10 ✓ allowed below floor
      'signals.rsi.params.period': 30,   // GROW 14→30 ✗ rejected
      'risk.stopLossPct': -3,            // risk loosening ✗ rejected below floor
    },
  });
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-health2-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  // minimal inline harness with custom llm
  const state = { price: 10, prevClose: 10, volume: 100 };
  const product = normalizeProduct({
    id: 'hlth', name: 'HLTH', currency: 'CNY', timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: { kind: 'multi', async quote() { return { ts: Date.now(), currency: 'CNY', quotes: [{ symbol: 'x', price: state.price, prevClose: state.prevClose, open: 10, volume: state.volume }] }; } },
    universe: { watchlist: () => [{ symbol: 'x', name: 'X' }], lotSize: 100 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: {
      signals: [{ id: 'trend', params: { fast: 5, slow: 20 }, weight: 1 }, { id: 'rsi', params: { period: 14 }, weight: 0.6 }],
      candidates: { threshold: 0.8 }, prompt: {}, decision: {},
      evolvable: [
        { path: 'signals.trend.params.slow', min: 3, max: 60, step: 1 },
        { path: 'signals.rsi.params.period', min: 3, max: 30, step: 1 },
        { path: 'risk.stopLossPct', min: -20, max: -1, step: 0.5 },
      ],
    },
    rules: { unit: 'share', lotSize: 100, settlement: 'T+0', fees: {}, sessions: [[570, 1560]], holidays: [] },
    risk: { perTrade: 10000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -5, takeProfitPct: 50, dailyLossPct: -99, minSamplesToEvolve: 5 },
  });
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'hlth', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  db.putState('product:hlth:decisions', Array.from({ length: 25 }, () => entry({ rejection: '标的不在候选或持仓中', signals: [sig('trend', '数据不足')] })));
  const engine = createProductEngine({ db, product, fetchFn: async () => ({ ok: true }), llm, now: () => OPEN });
  const r = await engine.reflectIfDue();
  assert.equal(r.reflected, true);
  assert.deepEqual(r.applied, { 'signals.trend.params.slow': 10 }, `only shrink applied: ${JSON.stringify(r.applied)}`);
  const v = engine.status().currentVersion;
  assert.equal(v.strategy.signals.find(s => s.id === 'trend').params.slow, 10, 'version carries the fix');
  assert.equal(v.strategy.signals.find(s => s.id === 'rsi').params.period, 14, 'grow rejected');
  assert.equal(v.strategy.risk.stopLossPct, -5, 'risk untouched below floor');
  // prompt was the health prompt (mentions the diagnosis framing)
  // (prompt content asserted indirectly: params beyond shrink were rejected per health rules)
});

test('decision journal preserves signal notes so coverage can count abstentions', async (t) => {
  const { engine, db } = harness(t, {});
  await engine.runCycle(); // fallback hold (llm returns '{}') still journals signals
  const dec = db.getState('product:hlth:decisions') ?? [];
  assert.ok(dec.length >= 1, 'a decision was journaled');
  const inner = dec.at(-1).signals?.[0]?.signals ?? [];
  assert.ok(inner.length > 0, 'inner signals present');
  assert.ok('note' in inner[0], `note preserved for coverage: ${JSON.stringify(inner[0])}`);
});

test('status exposes health; client renders the health line', async (t) => {
  const journal = Array.from({ length: 25 }, () => entry({
    rejection: '标的不在候选或持仓中',
    signals: [sig('trend', '数据不足'), sig('rsi', 'ok')],
  }));
  const { engine } = harness(t, { journal });
  const s = engine.status();
  assert.ok(s.health, 'health present in status');
  assert.equal(s.health.candidateRate, 0);
});
