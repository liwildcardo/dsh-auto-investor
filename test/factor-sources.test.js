import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import {
  parseFredCsv, computeDxy, collectFactors, readFactors, peFromQuote,
} from '../core/factor-sources.js';

const DAY = 86_400_000;

function harness(t) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-factor-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  return db;
}

test('parseFredCsv reads dates/values and skips missing observations', () => {
  const csv = 'observation_date,DFII10\n2026-11-06,2.05\n2026-11-07,.\n2026-11-08,1.97\n';
  const v = parseFredCsv(csv);
  assert.deepEqual(v, [
    { date: '2026-11-06', value: 2.05 },
    { date: '2026-11-08', value: 1.97 },
  ]);
  assert.equal(parseFredCsv('').length, 0);
  assert.equal(parseFredCsv('garbage').length, 0);
});

test('computeDxy matches the standard formula on a known rate vector', () => {
  // Rates in er-api shape (per-USD): EUR .85, JPY 150, GBP .75, CAD 1.37, SEK 10.7, CHF .88
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

test('FRED fetch caches for 26h and failures fall back to the cache', async (t) => {
  const db = harness(t);
  let clock = Date.UTC(2026, 10, 9, 4, 0);
  const now = () => clock;
  let calls = 0;
  let fail = false;
  const csv = 'observation_date,DFII10\n2026-11-06,2.05\n2026-11-07,1.97\n';
  const fetchFn = async (url) => {
    calls += 1;
    if (fail) throw new Error('network down');
    if (String(url).includes('er-api')) {
      return { ok: true, json: async () => ({ rates: { EUR: 0.85, JPY: 150, GBP: 0.75, CAD: 1.37, SEK: 10.7, CHF: 0.88 } }) };
    }
    return { ok: true, text: async () => csv };
  };
  const first = await collectFactors(fetchFn, db, now);
  const callsAfterFirst = calls;
  assert.ok(calls >= 1, 'initial fetch happened');
  assert.ok(Math.abs(first.realYield.value - 1.97) < 1e-9, 'latest observation');
  assert.equal(first.realYield.stale, false, 'fresh data');
  assert.ok(Number.isFinite(first.realYield.delta5d), 'delta derived from history');

  // Second collect within 26h: no refetch.
  await collectFactors(fetchFn, db, now);
  assert.equal(calls, callsAfterFirst, 'fresh cache skips refetch');

  // Beyond 26h (6 days) the network fails → cache survives; asOf is now
  // more than 5 days old → stale flag set.
  clock += 6 * DAY;
  fail = true;
  const degraded = await collectFactors(fetchFn, db, now);
  assert.ok(degraded.realYield, 'cache used on failure');
  assert.equal(degraded.realYield.value, 1.97, 'values preserved');
  assert.ok(degraded.realYield.stale, 'older than 5 days → stale');
});

test('factors older than 5 days are marked stale (signal will neutralize)', async (t) => {
  const db = harness(t);
  db.putState('factor:fred:DFII10', {
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
  db.putState('factor:fred:DFII10', {
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
