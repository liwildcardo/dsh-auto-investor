import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

// Regression: live tool output failed the harness's lossless-JSON check
// ("value is not lossless JSON"). Every tool-facing payload must round-trip.
const assertLossless = (v, label) =>
  assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), v, `${label} must be lossless JSON`);

function makeSqliteService(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-lossless-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'sqlite' });
  t.after(() => db.close());
  const cfg = resolveConfig({});
  const fetchFn = async (url) => String(url).includes('gold-api')
    ? { ok: true, json: async () => ({ price: 4090.0, currency: 'USD' }) }
    : { ok: true, json: async () => ({ rates: { CNY: 6.685421 } }), text: async () => '<rss></rss>' };
  const llm = async () => JSON.stringify({ action: 'hold', reason: 'test', confidence: 0.5, horizonHours: 6 });
  return createService({ db, cfg, fetchFn, llm, now: () => Date.UTC(2026, 10, 2, 2, 0) });
}

test('status() is lossless JSON with sqlite backend (live regression)', async (t) => {
  const svc = makeSqliteService(t);
  await svc.tickPrices();
  await svc.runCycle();
  const st = svc.status();
  assertLossless(st, 'status');
});

test('runCycle and manualTrade results are lossless JSON', async (t) => {
  const svc = makeSqliteService(t);
  await svc.tickPrices();
  const r = await svc.runCycle();
  assertLossless(r, 'runCycle result');
  const m = svc.manualTrade({ side: 'buy', rmb: 1200 });
  assertLossless(m, 'manualTrade result');
});

test('status with an empty DB is lossless JSON', (t) => {
  const svc = makeSqliteService(t);
  assertLossless(svc.status(), 'cold status');
});

test('runCycle surfaces LLM errors instead of swallowing them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-llmerr-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const fetchFn = async (url) => String(url).includes('gold-api')
    ? { ok: true, json: async () => ({ price: 4090.0 }) }
    : { ok: true, json: async () => ({ rates: { CNY: 6.685421 } }), text: async () => '<rss></rss>' };
  const llm = async () => { throw new Error('no LLM provider registered'); };
  const svc = createService({ db, cfg: resolveConfig({}), fetchFn, llm, now: () => Date.UTC(2026, 10, 2, 2, 0) });
  await svc.tickPrices();
  const r = await svc.runCycle();
  assert.equal(r.decision.action, 'hold'); // baseline fallback still decides
  assert.match(r.llmError ?? '', /no LLM provider/);
  assertLossless(r, 'runCycle with llm error');
});
