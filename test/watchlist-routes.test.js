import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { loadProducts } from '../core/registry.js';
import { createProductEngine } from '../core/engine.js';
import { createHub } from '../core/hub.js';
import { registerRoutes } from '../lib/routes.js';
import { parseSmartbox } from '../core/quotes.js';

function hubHarness(t, { fetchFn, enabled = ['hk'] } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-wlr-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const products = loadProducts({ enabled });
  const engines = products.map(p => createProductEngine({
    db, product: p, fetchFn: fetchFn ?? (async () => ({ ok: true })),
    llm: async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 }),
    now: () => Date.UTC(2026, 10, 2, 2, 0),
  }));
  const hub = createHub({ engines, products, fetchFn: fetchFn ?? (async () => ({ ok: true })) });
  const routes = [];
  const ctx = { connection: { fetch: { register: (r) => { routes.push(r); return () => {}; } } } };
  registerRoutes(ctx, hub, { lastRun: null });
  const call = async (path, method, body, query = '') => {
    const r = routes.find(x => x.path === path && x.methods.includes(method));
    assert.ok(r, `route ${method} ${path}`);
    const request = body === undefined
      ? { url: `http://local${path}${query}` }
      : { url: `http://local${path}${query}`, json: async () => body };
    const res = await r.fetch(request);
    return { status: res.status, body: await res.json() };
  };
  return { db, hub, engines, call };
}

test('watchlist routes: read defaults, add, remove, reset with validation', async (t) => {
  const { call } = hubHarness(t);

  const first = await call('/api/auto-investor/watchlist', 'GET', undefined, '?product=hk');
  assert.equal(first.status, 200);
  assert.equal(first.body.watchlist.length, 6, 'HK defaults served');

  const add = await call('/api/auto-investor/watchlist/edit', 'POST', { product: 'hk', action: 'add', symbol: 'hk00288', name: '银河娱乐' });
  assert.equal(add.status, 200);
  assert.equal(add.body.ok, true);
  assert.equal(add.body.watchlist.length, 7);

  const badPrefix = await call('/api/auto-investor/watchlist/edit', 'POST', { product: 'hk', action: 'add', symbol: 'sh600519' });
  assert.equal(badPrefix.status, 400, 'wrong-market code rejected');
  assert.match(badPrefix.body.error, /格式不符/);

  const dup = await call('/api/auto-investor/watchlist/edit', 'POST', { product: 'hk', action: 'add', symbol: 'hk00288' });
  assert.equal(dup.status, 400);

  const rm = await call('/api/auto-investor/watchlist/edit', 'POST', { product: 'hk', action: 'remove', symbol: 'hk00288' });
  assert.equal(rm.status, 200);
  assert.equal(rm.body.watchlist.length, 6);

  const reset = await call('/api/auto-investor/watchlist/edit', 'POST', { product: 'hk', action: 'reset' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.watchlist.length, 6);

  const unknown = await call('/api/auto-investor/watchlist', 'GET', undefined, '?product=bogus');
  assert.equal(unknown.status, 400);
});

test('search route filters by market and normalizes US casing', async (t) => {
  // ASCII-only payload: the real endpoint is GBK-decoded inside searchSymbols
  // (verified live); here we only prove market filtering + symbol shaping.
  const smartbox = 'v_hint="sh~000847~TENCENT-JA~txja~ZS^hk~00700~TENCENT~txkg~GP^us~tcehy~TENCENT-ADR~txkgadr~GP^us~aapl~APPLE~aapl~GP"';
  const fetchFn = async (url) => {
    assert.match(String(url), /smartbox\.gtimg\.cn/);
    // Exact-size ArrayBuffer: Buffer.from(str).buffer may expose a shared pool
    // holding other module sources (whose docs even contain a v_hint example).
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(smartbox).buffer };
  };
  const { call } = hubHarness(t, { fetchFn, enabled: ['hk', 'us'] });

  const hk = await call('/api/auto-investor/search', 'GET', undefined, '?product=hk&q=%E8%85%BE%E8%AE%AF');
  assert.equal(hk.status, 200);
  assert.equal(hk.body.results.length, 1, `HK search only returns hk-listed entries: ${JSON.stringify(hk.body)}`);
  assert.equal(hk.body.results[0].symbol, 'hk00700');

  const us = await call('/api/auto-investor/search', 'GET', undefined, '?product=us&q=tcehy');
  assert.equal(us.body.results.length, 2, 'US entries only');
  assert.equal(us.body.results[0].symbol, 'usTCEHY', 'US symbols upper-cased');
});

test('parseSmartbox keeps names and filters foreign markets (string level)', () => {
  const text = 'v_hint="hk~00700~腾讯控股~txkg~GP^badrow^sh~600519~贵州茅台~gzmt~GP"';
  const hk = parseSmartbox(text, 'hk');
  assert.equal(hk.length, 1, 'sh row filtered out for HK');
  assert.equal(hk[0].name, '腾讯控股');
  assert.equal(parseSmartbox('', 'hk').length, 0);
  assert.equal(parseSmartbox(text, 'gold').length, 0, 'gold has no search market');
});

test('engine candidates and history follow the edited pool', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-wle-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = loadProducts({ enabled: ['hk'] })[0];
  const seen = [];
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('fqkline')) {
      const sym = decodeURIComponent(u.match(/param=([^,]+)/)?.[1] ?? '');
      seen.push(sym);
      return { ok: true, json: async () => ({ data: { [sym]: { qfqday: [['2026-10-01', '400', '410', '420', '390', '1000'], ['2026-10-02', '410', '415', '425', '400', '1100'], ['2026-10-03', '415', '412', '420', '405', '900']] } } }) };
    }
    if (u.includes('qt.gtimg.cn')) return { ok: true, text: async () => 'v_hk00700="100~腾讯控股~00700~420~430~421~100~0~0~420"' };
    return { ok: true, json: async () => ({ data: {} }) };
  };
  const engine = createProductEngine({
    db, product, fetchFn, llm: async () => '{}', now: () => Date.UTC(2026, 10, 2, 2, 0),
  });

  // Default pool first symbol is the chart symbol.
  assert.equal(engine.status().chartSymbol, 'hk00700');
  assert.equal(engine.status().watchlist.length, 6);

  // Edit the pool: prepend a new symbol so it becomes the chart default.
  const r = engine.watchlistAction({ action: 'add', symbol: 'hk00981', name: '中芯国际' });
  assert.equal(r.ok, true);
  const after = engine.status();
  assert.equal(after.watchlist.length, 7);
  assert.ok(after.watchlist.some(w => w.symbol === 'hk00981'));

  await engine.tick();
  assert.ok(seen.includes('hk00981'), 'new symbol history seeded');
  assert.ok(seen.includes('hk00700'), 'existing symbols still seeded');
});

test('trades carry the symbol name from the pool', async (t) => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-wlt-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = loadProducts({ enabled: ['hk'] })[0];
  // Candidate bars: ascending with ~±3% daily swings (σ well above the HK 0.6%
  // floor), ending near the quoted 105 so trend + momentum both fire.
  for (let i = 0; i < 25; i += 1) {
    db.insertPoint({
      ts: Date.UTC(2026, 10, 2, 7, 0) - (25 - i) * 86_400_000,
      product: 'hk', symbol: 'hk09988',
      price: 80 + i * 1.2 + (i % 3) * 1.5,
    });
  }
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('qt.gtimg.cn')) {
      // hk09988 at 105 → one 100-share lot costs 10,500 HKD (within the 15k cap);
      // HK closes 16:00, so Friday 15:00 HKT is an open session.
      return { ok: true, text: async () => 'v_hk09988="100~阿里巴巴~09988~105~109~104~100~0~0~105"' };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  };
  const engine = createProductEngine({
    db, product, fetchFn,
    llm: async () => JSON.stringify({ action: 'buy', symbol: 'hk09988', amount: 12000, confidence: 0.9 }),
    now: () => Date.UTC(2026, 10, 2, 7, 0), // Friday 15:00 HKT
  });
  const res = await engine.runCycle();
  assert.equal(res.trades.length, 1, JSON.stringify(res));
  assert.equal(res.trades[0].name, '阿里巴巴', 'name attached to the fill');
  const stored = engine.status().trades[0];
  assert.equal(stored.symbol, 'hk09988');
  assert.equal(stored.name, '阿里巴巴', 'name persisted and returned by status');
});
