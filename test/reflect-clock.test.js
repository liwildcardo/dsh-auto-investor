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

function makeProduct() {
  return normalizeProduct({
    id: 'rc', name: 'RC', currency: 'CNY', timezone: 'Asia/Shanghai',
    capital: { initialRmb: 100000, maxExposureRmb: 100000 },
    market: {
      kind: 'multi',
      async quote() {
        return { ts: Date.now(), currency: 'CNY', quotes: [{ symbol: 'x', price: 10, prevClose: 10, open: 10, volume: 100 }] };
      },
    },
    universe: { watchlist: () => [{ symbol: 'x', name: 'X' }], lotSize: 100 },
    news: { feeds: [], queries: [], relevance: { core: [], context: [] }, perSymbol: false },
    strategy: {
      signals: [{ id: 'trend', params: { fast: 2, slow: 3 }, weight: 1 }],
      candidates: { threshold: 0.8 },
      prompt: {},
      decision: {},
      evolvable: [{ path: 'risk.stopLossPct', min: -60, max: -1, step: 0.5 }],
    },
    rules: { unit: 'share', lotSize: 100, settlement: 'T+0', fees: {}, sessions: [[570, 1560]], holidays: [] },
    risk: { perTrade: 10000, perSymbolPct: 100, minConfidence: 0.5, stopLossPct: -50, takeProfitPct: 50, dailyLossPct: -99, minSamplesToEvolve: 0 },
  });
}

test('a failed reflection does NOT consume the periodic cool-down (R2)', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rclock-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  // Periodic reflection is already due (last reflect far in the past).
  db.putState('product:rc:lastReflectAt', OPEN - 25 * 3600_000);
  let llmCalls = 0;
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => { llmCalls += 1; throw new Error('network down'); },
    now: () => OPEN,
  });
  const r1 = await engine.reflectIfDue();
  assert.equal(r1.reflected, true, 'attempted (periodic was due)');
  const journal = db.getState('product:rc:reflections') ?? [];
  assert.equal(journal.at(-1).llmFailed, true, 'failure recorded');
  assert.equal(db.getState('product:rc:lastReflectAt'), OPEN - 25 * 3600_000, 'clock NOT advanced on failure');
  // Still due → the next cycle retries instead of waiting another 24h.
  const r2 = await engine.reflectIfDue();
  assert.equal(r2.reflected, true, 'still due after the failed attempt');
  assert.equal(llmCalls, 2, 'the LLM was called again');
});

test('failure diagnostics distinguish a thrown call from unparseable output', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rdiag-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  // Case 1: LLM returns prose without JSON → unparseable + raw snippet.
  const engine1 = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => '我觉得策略没问题，无需调整参数。',
    now: () => OPEN,
  });
  await engine1.reflectIfDue({ force: true });
  let last = (db.getState('product:rc:reflections') ?? []).at(-1);
  assert.equal(last.llmFailed, true);
  assert.equal(last.failReason, 'unparseable');
  assert.ok(last.rawSnippet?.includes('策略没问题'), 'raw output kept for diagnosis');
  // Case 2: LLM call throws → llm-error, no snippet.
  const engine2 = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => { throw new Error('network down'); },
    now: () => OPEN,
  });
  await engine2.reflectIfDue({ force: true });
  last = (db.getState('product:rc:reflections') ?? []).at(-1);
  assert.equal(last.failReason, 'llm-error');
  assert.equal(last.rawSnippet, undefined, 'no snippet when the call itself failed');
});

test('unparseable output does not advance the clock and folds into one journal marker', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rfold-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  db.putState('product:rc:lastReflectAt', OPEN - 25 * 3600_000);
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => '这是一段没有 JSON 的评语', // unparseable, no throw
    now: () => OPEN,
  });
  await engine.reflectIfDue({ force: true });
  let journal = db.getState('product:rc:reflections') ?? [];
  assert.equal(journal.at(-1).failReason, 'unparseable');
  assert.equal(db.getState('product:rc:lastReflectAt'), OPEN - 25 * 3600_000, 'clock NOT advanced');
  // Second failure folds into the same marker (journal must not spam).
  await engine.reflectIfDue({ force: true });
  journal = db.getState('product:rc:reflections') ?? [];
  assert.equal(journal.length, 1, 'consecutive failures collapse to one entry');
  assert.equal(journal.at(-1).llmFailed, true);
});

test('a failed loss-triggered reflection does not fork a junk version', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rfork-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  const versionsBefore = (db.getState('product:rc:versions') ?? []).length || 1;
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => { throw new Error('network down'); },
    now: () => OPEN,
  });
  // Seed loss stats: a realized close far below the loss threshold.
  db.insertTrade({ ts: OPEN - 1000, side: 'sell', grams: 100, price: 9, rmb: 900, product: 'rc', symbol: 'x', realized: -5000 });
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.reflected, true);
  assert.equal(r.versionCreated, false, 'no fork when the LLM failed');
  const journal = db.getState('product:rc:reflections') ?? [];
  assert.equal(journal.at(-1).versionCreated, false, 'journal agrees');
});

test('a forked version records the critique that created it', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rwhy-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ critique: '收紧止损更稳', params: { 'risk.stopLossPct': -40 } }),
    now: () => OPEN,
  });
  const r = await engine.reflectIfDue({ force: true });
  assert.equal(r.versionCreated, true, 'param change forks a version');
  assert.equal(r.version.critique, '收紧止损更稳', 'per-version critique stored (paged in the UI)');
});

test('applyParams records the raw proposal and names each rejection (audit C2/M7)', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rrej-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  let proposal = -50; // equals the current stopLossPct (-50) → no-change
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ critique: '调整止损', params: { 'risk.stopLossPct': proposal } }),
    now: () => OPEN,
  });
  const r1 = await engine.reflectIfDue({ force: true });
  assert.deepEqual(r1.applied, {}, 'a no-op proposal applies nothing');
  assert.equal(r1.versionCreated, false, 'no empty version fork');
  let last = (db.getState('product:rc:reflections') ?? []).at(-1);
  assert.deepEqual(last.params, { 'risk.stopLossPct': -50 }, 'raw proposal recorded');
  assert.ok(last.rejected?.some(x => x.reason === 'no-change'), 'no-change named');

  proposal = -5; // 45-point jump from -50, allowed is 10 → jump-guard
  await engine.reflectIfDue({ force: true });
  last = (db.getState('product:rc:reflections') ?? []).at(-1);
  assert.ok(last.rejected?.some(x => x.reason === 'jump-guard'), 'jump-guard named');
  assert.equal(last.versionCreated, false);
});

test('historical versions recover their critique from the journal (audit M9)', (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rback-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  const mk = (id) => ({ id, createdAt: id, strategy: { signals: [{ id: 'trend' }], risk: {} }, startPnl: 0, critique: null });
  db.putState('product:rc:versions', [mk(1), mk(2), mk(3)]);
  db.putState('product:rc:reflections', [
    { ts: 10, versionCreated: true, critique: 'A理由' },
    { ts: 20, versionCreated: false, critique: '不分叉的复盘' },
    { ts: 30, versionCreated: true, critique: 'B理由' },
  ]);
  createProductEngine({ db, product, fetchFn: async () => ({ ok: true }), llm: async () => '{}', now: () => OPEN });
  const v = db.getState('product:rc:versions');
  assert.equal(v[0].critique, null, 'v1 untouched');
  assert.equal(v[1].critique, 'A理由', 'first forked version gets the first fork critique');
  assert.equal(v[2].critique, 'B理由', 'non-fork entries do not shift the mapping');
});

test('a successful reflection advances the cool-down (R2)', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-rclock2-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = makeProduct();
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({ ts: OPEN - (25 - i) * DAY, product: 'rc', symbol: 'x', price: 10 - (24 - i) * 0.01 });
  }
  db.putState('product:rc:lastReflectAt', OPEN - 25 * 3600_000);
  const engine = createProductEngine({
    db, product, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ critique: 'ok', params: {} }),
    now: () => OPEN,
  });
  await engine.reflectIfDue();
  assert.equal(db.getState('product:rc:lastReflectAt'), OPEN, 'clock advanced on success');
  const r2 = await engine.reflectIfDue();
  assert.equal(r2.reflected, false, 'cool-down active after success');
});
