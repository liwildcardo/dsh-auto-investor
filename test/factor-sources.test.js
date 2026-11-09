import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import {
  parseEmQuote, computeDxy, collectFactors, readFactors, peFromQuote,
} from '../core/factor-sources.js';

const DAY = 86_400_000;

function harness(t) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-factor-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  return db;
}

test('parseEmQuote scales f43 by 1000 and reads the quote date', () => {
  const now = () => Date.parse('2026-11-09T12:00:00Z');
  const p = parseEmQuote({ data: { f43: 26190, f86: 1794231430, f58: '美国10年期通胀国债收益率' } }, now);
  assert.ok(Math.abs(p.value - 2.619) < 1e-9, `value 2.619, got ${p.value}`);
  assert.equal(p.asOf, '2026-11-09', 'Shanghai date of the quote');
  assert.equal(p.name, '美国10年期通胀国债收益率');
  assert.equal(parseEmQuote({ data: { f86: 1 } }, now), null, 'missing f43 → null');
  assert.equal(parseEmQuote(null, now), null);
});

test('computeDxy matches the standard formula on a known rate vector', () => {
  const rates = { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 };
  const expected = 50.14348112
    * Math.pow(1 / 0.85, 0.576)
    * Math.pow(150, 0.136)
    * Math.pow(1 / 0.75, 0.119)
    * Math.pow(1.37, 0.091)
    * Math.pow(10.7, 0.042)
    * Math.pow(0.88, 0.036);
  const dxy = computeDxy(rates);
  assert.ok(Math.abs(dxy - expected) < 1e-9);
  assert.ok(dxy > 80 && dxy < 130, `plausible index level, got ${dxy}`);
  assert.equal(computeDxy({ EUR: 0.85 }), null, 'missing rates → null');
});

test('factor fetch caches for 26h and failures fall back to the cache', async (t) => {
  const db = harness(t);
  let clock = Date.UTC(2026, 10, 9, 4, 0);
  const now = () => clock;
  let calls = 0;
  let fail = false;
  const fetchFn = async (url) => {
    calls += 1;
    if (fail) throw new Error('network down');
    if (String(url).includes('push2.eastmoney.com')) {
      return { ok: true, json: async () => ({ data: { f43: 26190, f86: Math.floor(clock / 1000) } }) };
    }
    return { ok: true, json: async () => ({ rates: { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } }) };
  };
  const first = await collectFactors(fetchFn, db, now);
  const callsAfterFirst = calls;
  assert.ok(calls >= 1, 'initial fetch happened');
  assert.ok(Math.abs(first.realYield.value - 2.619) < 1e-9, 'scaled value');
  assert.equal(first.realYield.stale, false, 'fresh data');
  assert.equal(first.realYield.delta5d, null, 'needs ≥2 observations');

  // Second collect within 26h: no refetch.
  await collectFactors(fetchFn, db, now);
  assert.equal(calls, callsAfterFirst, 'fresh cache skips refetch');

  // Beyond 26h the network fails → cache survives; asOf is now more than
  // 5 days old → stale flag set, error diagnostics recorded.
  clock += 6 * DAY;
  fail = true;
  const degraded = await collectFactors(fetchFn, db, now);
  assert.ok(degraded.realYield, 'cache used on failure');
  assert.equal(degraded.realYield.value, 2.619, 'values preserved');
  assert.ok(degraded.realYield.stale, 'older than 5 days → stale');
});

test('factors older than 5 days are marked stale (signal will neutralize)', (t) => {
  const db = harness(t);
  db.putState('factor:em:UI10Y', {
    values: [{ date: '2026-10-01', value: 2.2 }, { date: '2026-10-02', value: 2.1 }],
    asOf: '2026-10-02', fetchedAt: Date.now(),
  });
  const fresh = readFactors(db, () => Date.parse('2026-10-05T00:00:00Z'));
  assert.equal(fresh.realYield.stale, false, '3 days old → fresh');
  const old = readFactors(db, () => Date.parse('2026-11-09T00:00:00Z'));
  assert.equal(old.realYield.stale, true, '38 days old → stale');
});

test('readFactors derives delta5d in percentage points and percent', (t) => {
  const db = harness(t);
  db.putState('factor:em:UI10Y', {
    values: [
      { date: '2026-11-01', value: 2.20 },
      { date: '2026-11-08', value: 2.05 }, // −15bp over 7 days
    ],
    asOf: '2026-11-08', fetchedAt: Date.now(),
  });
  db.putState('factor:usdIndex', {
    values: [
      { date: '2026-11-01', value: 100 },
      { date: '2026-11-08', value: 99 }, // −1%
    ],
    value: 99, asOf: '2026-11-08', fetchedAt: Date.now(),
  });
  const f = readFactors(db, () => Date.parse('2026-11-09T00:00:00Z'));
  assert.ok(Math.abs(f.realYield.delta5d - (-0.15)) < 1e-9, 'pp difference');
  assert.ok(Math.abs(f.usdIndex.delta5d - (-1)) < 1e-9, 'percent change');
  assert.equal(f.inflationExp, undefined, 'dropped: no free source');
});

test('peFromQuote reads field 39 across markets', () => {
  const mk = (pe39) => Array.from({ length: 50 }, (_, i) => (i === 39 ? String(pe39) : '0'));
  assert.equal(peFromQuote(mk('21.99')), 21.99, 'A-share Maotai');
  assert.equal(peFromQuote(mk('15.28')), 15.28, 'HK Tencent');
  assert.equal(peFromQuote(mk('38.13')), 38.13, 'US AAPL');
  assert.equal(peFromQuote(mk('')), null, 'empty → null');
  assert.equal(peFromQuote(mk('-3')), null, 'negative → null');
  assert.equal(peFromQuote(undefined), null);
});
