import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { loadProducts } from '../core/registry.js';
import {
  loadWatchlist, addToWatchlist, removeFromWatchlist, resetWatchlist, WATCHLIST_LIMIT,
} from '../core/watchlist.js';

function harness(t, id) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-wl-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const product = loadProducts({ enabled: [id] })[0];
  return { db, product };
}

test('defaults are used until the pool is persisted', (t) => {
  const { db, product } = harness(t, 'hk');
  const list = loadWatchlist(db, product);
  assert.equal(list.length, 6, 'HK ships six defaults');
  assert.equal(list[0].symbol, 'hk00700');
  assert.ok(list.every(w => w.symbol && w.name), 'each entry carries code and name');
  // Reading again must not create state (still defaults until mutated).
  assert.equal(db.getState('product:hk:watchlist'), null);
});

test('add appends, dedupes, and persists', (t) => {
  const { db, product } = harness(t, 'hk');
  const r1 = addToWatchlist(db, product, 'hk00288', '银河娱乐');
  assert.equal(r1.ok, true);
  assert.equal(r1.watchlist.length, 7);
  assert.equal(loadWatchlist(db, product)[6].symbol, 'hk00288');
  const r2 = addToWatchlist(db, product, 'hk00288', 'dup');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /已在自选池/);
});

test('market prefix is enforced per product', (t) => {
  const { db, product } = harness(t, 'hk');
  assert.match(addToWatchlist(db, product, 'sh600519', 'x').error, /格式不符/);
  assert.match(addToWatchlist(db, product, 'usAAPL', 'x').error, /格式不符/);
  const a = harness(t, 'ashare');
  assert.equal(addToWatchlist(a.db, a.product, 'sh601398', '工商银行').ok, true);
  assert.match(addToWatchlist(a.db, a.product, 'hk00700', 'x').error, /格式不符/);
});

test('pool overflow and empty-pool removal are refused', (t) => {
  const { db, product } = harness(t, 'hk');
  for (const sym of ['hk00001', 'hk00002', 'hk00003', 'hk00004']) {
    addToWatchlist(db, product, sym, '');
  }
  assert.equal(loadWatchlist(db, product).length, WATCHLIST_LIMIT);
  const full = addToWatchlist(db, product, 'hk00005', '');
  assert.equal(full.ok, false);
  assert.match(full.error, /已满/);
  // Remove everything except one, then refuse the last removal.
  let list = loadWatchlist(db, product);
  while (list.length > 1) {
    const r = removeFromWatchlist(db, product, list[0].symbol);
    assert.equal(r.ok, true);
    list = r.watchlist;
  }
  const last = removeFromWatchlist(db, product, list[0].symbol);
  assert.equal(last.ok, false);
  assert.match(last.error, /不能为空/);
});

test('reset restores the built-in defaults', (t) => {
  const { db, product } = harness(t, 'ashare');
  const defaults = loadWatchlist(db, product).length; // A-share ships 8 defaults
  addToWatchlist(db, product, 'sh601398', '工商银行');
  removeFromWatchlist(db, product, 'sh600519');
  const r = resetWatchlist(db, product);
  assert.equal(r.ok, true);
  assert.equal(r.watchlist.length, defaults);
  assert.equal(r.watchlist[0].symbol, 'sh600519');
  assert.equal(loadWatchlist(db, product)[0].symbol, 'sh600519');
});

test('gold keeps a single-symbol pool (AU9999) and ignores prefix rules', (t) => {
  const { db, product } = harness(t, 'gold');
  const list = loadWatchlist(db, product);
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'AU9999');
  const add = addToWatchlist(db, product, 'XAUUSD', 'test');
  assert.equal(add.ok, true, 'gold accepts non-prefixed symbols');
});
