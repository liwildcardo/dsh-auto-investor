import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';

function freshDb(t, kind) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-db-'));
  const db = openDb(join(dir, 'test.db'), { backend: kind });
  t.after(() => db.close());
  return db;
}

for (const kind of ['json', 'sqlite']) {
  test(`db[${kind}] tick insert + latestTicks ordering`, (t) => {
    const db = freshDb(t, kind);
    db.insertTick({ ts: 1000, xauUsd: 4000, usdCny: 7, mid: 900, buy: 902.5, sell: 897.5 });
    db.insertTick({ ts: 2000, xauUsd: 4100, usdCny: 7, mid: 920, buy: 922.5, sell: 917.5 });
    const latest = db.latestTicks(10);
    assert.equal(latest.length, 2);
    assert.equal(latest[0].ts, 1000);
    assert.equal(latest[1].ts, 2000);
    const tail = db.latestTicks(1);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].ts, 2000);
  });

  test(`db[${kind}] product dimension isolates ticks, trades and series`, (t) => {
    const db = freshDb(t, kind);
    db.insertTick({ ts: 1000, mid: 900, buy: 902, sell: 898 });                    // legacy → gold
    db.insertTick({ ts: 2000, mid: 10, buy: 10, sell: 10, product: 'ashare' });
    assert.equal(db.latestTicksByProduct('gold', 10).length, 1);
    assert.equal(db.latestTicksByProduct('ashare', 10).length, 1);
    assert.equal(db.latestTicksByProduct('ashare', 10)[0].price, 10);
    db.insertTrade({ ts: 1, side: 'buy', grams: 0, price: 1, rmb: 100, product: 'ashare', symbol: 'sh600000' });
    db.insertTrade({ ts: 2, side: 'buy', grams: 1, price: 900, rmb: 900 });
    assert.equal(db.listTradesByProduct('ashare', 10).length, 1);
    assert.equal(db.listTradesByProduct('ashare', 10)[0].symbol, 'sh600000');
    assert.equal(db.listTradesByProduct('gold', 10).length, 1);
    db.insertPoint({ ts: 5, product: 'ashare', symbol: 'sh600000', price: 10, volume: 100 });
    db.insertPoint({ ts: 6, product: 'ashare', symbol: 'sh600000', price: 11, volume: 120 });
    const points = db.listPoints('ashare', 'sh600000', 10);
    assert.equal(points.length, 2);
    assert.equal(points.at(-1).price, 11);
  });

  test(`db[${kind}] news dedupe by url hash`, (t) => {
    const db = freshDb(t, kind);
    const item = { url: 'https://example.com/a', title: '央行增持黄金', source: 'test', ts: 1 };
    const first = db.upsertNews(item);
    const second = db.upsertNews({ ...item, ts: 2 });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(db.latestNews(10).length, 1);
  });

  test(`db[${kind}] estimated news timestamp is upgraded by a real date`, (t) => {
    const db = freshDb(t, kind);
    const url = 'https://example.com/est';
    db.upsertNews({ url, title: '贵金属周报674期', source: 's', ts: 5000, tsEstimated: true });
    const before = db.latestNews(1)[0];
    assert.equal(before.tsEstimated, true, 'estimate flagged');
    const upgraded = db.upsertNews({ url, title: '贵金属周报674期', source: 's', ts: 9000, tsEstimated: false });
    assert.equal(upgraded, false, 'not a new row');
    const after = db.latestNews(1)[0];
    assert.equal(after.tsEstimated, false, 'estimate cleared');
    assert.equal(after.ts, 9000, 'real date replaces crawl time');
  });

  test(`db[${kind}] latestNews tie order is newest-inserted first`, (t) => {
    const db = freshDb(t, kind);
    db.upsertNews({ url: 'https://example.com/a', title: 'A 黄金新闻', source: 's', ts: 1000 });
    db.upsertNews({ url: 'https://example.com/b', title: 'B 黄金新闻', source: 's', ts: 1000 });
    const order = db.latestNews(10).map(n => n.title[0]);
    assert.deepEqual(order, ['B', 'A'], 'same ts → later insert first (sqlite rowid parity)');
  });

  test(`db[${kind}] removeNews deletes by hash`, (t) => {
    const db = freshDb(t, kind);
    db.upsertNews({ url: 'https://example.com/a', title: '黄金', source: 'test', ts: 1 });
    db.upsertNews({ url: 'https://example.com/b', title: '无关', source: 'test', ts: 2 });
    const before = db.latestNews(10);
    assert.equal(before.length, 2);
    const gone = before.find(n => n.title === '无关');
    db.removeNews(gone.hash);
    const after = db.latestNews(10);
    assert.equal(after.length, 1);
    assert.equal(after[0].title, '黄金');
  });

  test(`db[${kind}] trades list`, (t) => {
    const db = freshDb(t, kind);
    db.insertTrade({ ts: 1, side: 'buy', grams: 2, price: 850, rmb: 1700, note: '' });
    db.insertTrade({ ts: 2, side: 'sell', grams: 1, price: 860, rmb: 860, note: '' });
    const trades = db.listTrades(10);
    assert.equal(trades.length, 2);
    // most recent first (UI order)
    assert.equal(trades[0].side, 'sell');
    assert.equal(trades[1].side, 'buy');
  });

  test(`db[${kind}] state put/get`, (t) => {
    const db = freshDb(t, kind);
    db.putState('portfolio', { grams: 39.8934, costAvg: 877.34 });
    const got = db.getState('portfolio');
    assert.equal(got.grams, 39.8934);
    assert.equal(db.getState('missing'), null);
  });
}

test('json backend survives reopen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-db-'));
  const path = join(dir, 'persist.db');
  const db1 = openDb(path, { backend: 'json' });
  db1.insertTrade({ ts: 9, side: 'buy', grams: 1, price: 850, rmb: 850, note: '' });
  db1.close();
  const db2 = openDb(path, { backend: 'json' });
  t.after(() => db2.close());
  assert.equal(db2.listTrades(10).length, 1);
});

test('json backend never writes over an existing non-JSON file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-db-'));
  const path = join(dir, 'auto-investor.db');
  // simulate a SQLite database on the sqlite path
  writeFileSync(path, 'SQLite format 3\u0000', 'utf8');
  const db = openDb(path, { backend: 'json' });
  t.after(() => db.close());
  db.insertTrade({ ts: 1, side: 'buy', grams: 1, price: 850, rmb: 850, note: '' });
  // the original file (sqlite bytes) must be untouched; json goes elsewhere
  assert.equal(readFileSync(path, 'utf8'), 'SQLite format 3\u0000');
  const sidecar = readFileSync(`${path}.json`, 'utf8');
  assert.ok(sidecar.includes('"trades"'), 'json store written to sidecar path');
});

test('corrupt json store is preserved aside, not silently discarded', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-db-'));
  const path = join(dir, 'store.json');
  writeFileSync(path, '{not valid json', 'utf8');
  const db = openDb(path, { backend: 'json' });
  t.after(() => db.close());
  db.insertTrade({ ts: 1, side: 'buy', grams: 1, price: 850, rmb: 850, note: '' });
  const siblings = readdirSync(dir);
  assert.ok(siblings.some(f => f.includes('.corrupt-')), `corrupt file kept: ${siblings}`);
  assert.ok(readFileSync(path, 'utf8').includes('"trades"'));
});

test('sqlite store prunes ticks beyond the retention cap', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-db-'));
  const db = openDb(join(dir, 'p.db'), { backend: 'sqlite' });
  t.after(() => db.close());
  for (let i = 0; i < 50; i++) {
    db.insertTick({ ts: i, xauUsd: 4000, usdCny: 7, mid: 900, buy: 902.5, sell: 897.5 });
  }
  db.pruneTicks(30);
  assert.ok(db.latestTicks(100).length <= 30, `left ${db.latestTicks(100).length}`);
});
