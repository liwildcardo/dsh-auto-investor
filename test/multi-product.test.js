import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { migrateGoldState } from '../core/migrate.js';
import { scoreRelevance, relevant } from '../lib/news.js';
import { createProductEngine } from '../core/engine.js';
import { createHub } from '../core/hub.js';
import { registerRoutes } from '../lib/routes.js';
import { loadProducts } from '../core/registry.js';
import { fetchMinuteHistory } from '../core/quotes.js';

test('gold-era state migrates into the product:gold namespace once', (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-mig-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  db.putState('portfolio', { cash: 95000, grams: 2, termGrams: 3, costAvg: 875, realizedPnl: 12, investedRmb: 4375 });
  db.putState('versions', [{
    id: 1, createdAt: 1, strategy: { plan: { maxTradesPerDay: 2 } }, startPnl: 0,
    trades: 4, wins: 2, fills: 6, peakPnl: 30, maxDrawdownPnl: -12, reference: true,
  }]);
  db.putState('reflections', [{ ts: 1, critique: 'ok' }]);
  db.putState('paused', false);
  db.putState('lastReflectAt', 42);

  const r1 = migrateGoldState(db);
  assert.equal(r1.migrated, true);
  const acct = db.getState('product:gold:account');
  assert.equal(acct.cash, 95000);
  assert.equal(acct.positions.AU9999.qty, 5, 'demand + term grams both migrate');
  assert.equal(acct.positions.AU9999.costAvg, 875);
  const v = db.getState('product:gold:versions')[0];
  assert.equal(v.trades, 4, 'historical trade count preserved');
  assert.equal(v.wins, 2);
  assert.equal(v.maxDrawdownPnl, -12);
  assert.equal(v.reference, true);
  assert.deepEqual(v.strategy.signals, [], 'legacy version has no rule params (engine falls back)');
  assert.equal(db.getState('product:gold:reflections').length, 1);
  assert.equal(db.getState('product:gold:lastReflectAt'), 42);

  const r2 = migrateGoldState(db); // idempotent
  assert.equal(r2.migrated, false);
});

test('product relevance keeps the product’s own news and drops others', () => {
  const ashare = { core: ['A股', '上市公司', '业绩'], context: ['成交额', '降准', '政策'] };
  assert.ok(relevant({ title: 'A股三大指数集体上涨', description: '成交额放大' }, ashare), 'A-share news kept');
  assert.ok(!relevant({ title: '央行增持黄金0.93吨', description: '金价上涨' }, ashare), 'gold news filtered out');
  assert.ok(scoreRelevance({ title: '贵州茅台发布业绩预告' }, ashare) >= 2, 'core keyword scored');
});

test('daily history seeds the series so indicators are computable', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-hist-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = loadProducts({ enabled: ['ashare'] })[0];
  const kline = {
    data: {
      sh600519: {
        qfqday: [
          ['2026-10-01', '1400', '1450', '1460', '1390', '1000'],
          ['2026-10-02', '1450', '1470', '1480', '1440', '1200'],
          ['2026-10-03', '1470', '1460', '1475', '1450', '900'],
        ],
      },
    },
  };
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('fqkline')) return { ok: true, json: async () => kline };
    if (u.includes('qt.gtimg.cn')) {
      return { ok: true, text: async () => 'v_sh600519="1~X~600519~1450~1440~1441~100000~0~0~0~0~0~0~0~0~0~0~0"' };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  };
  const engine = createProductEngine({
    db, product, fetchFn, llm: async () => '{}', now: () => Date.UTC(2026, 10, 2, 2, 0),
  });
  await engine.tick();
  const st = engine.status();
  assert.ok(st.series.length >= 3, `series seeded (${st.series.length})`);
  assert.ok(st.series.every(p => Number.isFinite(p.price)));
});

test('minute history parses Tencent rows (fallback when daily bars are thin)', async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ data: { hk00700: { data: { date: '20261107', data: ['0930 421.000 1', '0931 420.500 2'] } } } }),
  });
  const rows = await fetchMinuteHistory(fetchFn, 'hk00700');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].price, 420.5);
  assert.ok(Number.isFinite(rows[0].ts));
});

test('productConfig overrides deep-merge (risk defaults survive)', () => {
  const [p] = loadProducts({ enabled: ['ashare'], overrides: { ashare: { risk: { perTrade: 8000 } } } });
  assert.equal(p.risk.perTrade, 8000, 'override applied');
  assert.equal(p.risk.perSymbolPct, 25, 'sibling risk defaults kept');
  assert.equal(p.risk.stopLossPct, -5, 'other risk defaults kept');
});

test('hub routes reject an unknown product instead of falling back to gold', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-hubr-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const products = loadProducts({ enabled: ['gold', 'ashare'] });
  const engines = products.map(p => createProductEngine({
    db, product: p, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 }),
    now: () => Date.UTC(2026, 10, 2, 2, 0),
  }));
  const hub = createHub({ engines, products });
  const routes = [];
  const ctx = { connection: { fetch: { register: (r) => { routes.push(r); return () => {}; } } } };
  registerRoutes(ctx, hub, { lastRun: null });
  const stateRoute = routes.find(r => r.path === '/api/auto-investor/state');
  const res = await stateRoute.fetch({ url: 'http://local/api/auto-investor/state?product=bogus' });
  assert.equal(res.status, 400);
  const ok = await stateRoute.fetch({ url: 'http://local/api/auto-investor/state?product=ashare' });
  assert.equal(ok.status, 200);
});

test('hub dispatches calls to the right product engine', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-hub-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const products = loadProducts({ enabled: ['gold', 'ashare'] });
  const engines = products.map(p => createProductEngine({
    db, product: p, fetchFn: async () => ({ ok: true }),
    llm: async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 }),
    now: () => Date.UTC(2026, 10, 2, 2, 0),
  }));
  const hub = createHub({ engines, products });
  assert.deepEqual(hub.products().map(p => p.id), ['gold', 'ashare']);
  const gold = hub.status('gold');
  const ashare = hub.status('ashare');
  assert.equal(gold.product.id, 'gold');
  assert.equal(ashare.product.id, 'ashare');
  assert.equal(hub.pause('ashare', true), true);
  assert.equal(hub.status('ashare').paused, true);
  assert.equal(hub.status('gold').paused, false);
});
