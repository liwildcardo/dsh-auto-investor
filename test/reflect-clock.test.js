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
      candidates: { threshold: 0.8 }, prompt: {}, decision: {}, evolvable: [],
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
