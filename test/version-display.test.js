import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

const HOUR = 3600_000;

function makeDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-vd-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  return db;
}

function serviceFor(t, db, opts = {}) {
  const cfg = resolveConfig({});
  let clock = opts.start ?? Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 Shanghai
  const prices = opts.prices ?? [4090];
  let idx = 0;
  const fetchFn = async (url) => String(url).includes('gold-api')
    ? { ok: true, json: async () => ({ price: prices[Math.min(idx++, prices.length - 1)] }) }
    : { ok: true, json: async () => ({ rates: { CNY: 7 } }), text: async () => '<rss></rss>' };
  const llm = opts.llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 }));
  const svc = createService({ db, cfg, fetchFn, llm, now: () => clock });
  return { svc, setClock: (c) => { clock = c; } };
}

test('version display is marked-to-market with real fill/close counts', async (t) => {
  const db = makeDb(t);
  const { svc, setClock } = serviceFor(t, db, { prices: [4090, 4000, 4090, 4090] });
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 2000 });

  // after the buy: one fill, no closes -> win rate must be null (N/A), not 0%
  let d = svc.status().versions.at(-1).display;
  assert.equal(d.fills, 1, 'one fill');
  assert.equal(d.closes, 0, 'no closes');
  assert.equal(d.winRate, null, 'no closed trades -> win rate N/A');

  // price drops: marked return and drawdown must go negative
  await svc.tickPrices(); // 4000
  d = svc.status().versions.at(-1).display;
  assert.ok(d.returnPnl < -30, `marked return after drop: ${d.returnPnl}`);
  assert.ok(d.maxDrawdownPnl < -30, `accumulated drawdown: ${d.maxDrawdownPnl}`);
  const troughDd = d.maxDrawdownPnl;

  // price recovers: return recovers (still shows the spread cost) but the
  // drawdown must KEEP the trough. Spread loss ≈ 5元/克 × ~2.17克 ≈ -10.8.
  await svc.tickPrices(); // 4090
  d = svc.status().versions.at(-1).display;
  assert.ok(d.returnPnl > -15, `return after recovery: ${d.returnPnl}`);
  assert.ok(d.maxDrawdownPnl <= troughDd, 'drawdown must not reset on recovery');

  // a losing close -> win rate 0% (a real zero, not N/A)
  setClock(Date.UTC(2026, 10, 2, 7, 0)); // Mon 15:00, same session
  await svc.tickPrices(); // fresh quote for staleness
  const sell = svc.manualTrade({ side: 'sell', grams: 0.5 });
  assert.equal(sell.ok, true, `sell rejected: ${sell.reason}`);
  d = svc.status().versions.at(-1).display;
  assert.equal(d.closes, 1, 'one close');
  assert.equal(d.fills, 2, 'buy + sell');
  assert.equal(d.winRate, 0, 'losing close -> 0%');
});

test('legacy version gets inception baseline and reconstructed stats', (t) => {
  const db = makeDb(t);
  const T1 = Date.UTC(2026, 10, 2, 0, 30); // 08:30 SH — before any fill
  const T2 = T1 + 5 * HOUR; // fork at 13:30 SH
  // legacy v1: created before the first fill, baseline lazily corrupted mid-life,
  // no fills/mtm fields (pre-fix shape)
  db.putState('versions', [
    {
      id: 1, strategy: { action: 'hold' }, createdAt: T1,
      trades: 4, wins: 0, consecLosses: 0, returnPnl: 0, peakPnl: 0, maxDrawdownPnl: 0,
      reference: false, retired: true, startPnl: -134.51,
    },
    {
      id: 2, strategy: { action: 'hold' }, createdAt: T2,
      trades: 0, fills: 0, wins: 0, consecLosses: 0, returnPnl: 0, peakPnl: 0, maxDrawdownPnl: 0,
      reference: false, retired: false, startPnl: -41.05,
    },
  ]);
  db.insertTrade({ ts: T1 + HOUR, side: 'buy', grams: 3000 / 877, price: 877, rmb: 3000, note: '' });
  for (const [dt, sell] of [[2, 870], [3, 860], [4, 865]]) {
    db.insertTick({ ts: T1 + dt * HOUR, xauUsd: 4000, usdCny: 7, mid: sell + 2.5, buy: sell + 5, sell });
  }

  const { svc } = serviceFor(t, db);
  const st = svc.status();
  const v1 = st.versions[0];
  const d = v1.display;

  // baseline corrected to inception (book was empty before the first fill)
  assert.equal(v1.startPnl, 0, 'inception baseline');
  // real counts from the trade log, not the legacy trades counter
  assert.equal(d.fills, 1, 'fills from trade log');
  assert.equal(d.closes, 0, 'no closes');
  assert.equal(d.winRate, null, 'N/A win rate');
  // frozen return at fork = successor baseline - own baseline
  assert.ok(Math.abs(d.returnPnl - -41.05) < 0.01, `frozen return: ${d.returnPnl}`);
  // reconstructed peak-to-trough drawdown (buy@877 -> trough sell 860)
  const expectedDd = (860 - 877) * (3000 / 877);
  assert.ok(Math.abs(d.maxDrawdownPnl - expectedDd) < 0.5, `dd=${d.maxDrawdownPnl} expected≈${expectedDd}`);
  // current version still displays live
  assert.ok(st.currentVersion.display, 'current version has display stats');
});
