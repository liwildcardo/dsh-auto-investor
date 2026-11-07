import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccount, applyBuy, applySell, positionOf, snapshotOf,
} from '../core/account.js';

test('buy reduces cash, tracks cost average and settlement time', () => {
  const a = createAccount({ currency: 'CNY', initial: 100000 });
  applyBuy(a, { symbol: 'sh600000', qty: 1000, price: 10, fee: 5, ts: 100, earliestSellTs: 200 });
  const p = positionOf(a, 'sh600000');
  assert.equal(p.qty, 1000);
  assert.equal(p.costAvg, 10);
  assert.equal(p.earliestSellTs, 200);
  assert.equal(a.cash, 100000 - 10000 - 5);
  applyBuy(a, { symbol: 'sh600000', qty: 1000, price: 12, fee: 5, ts: 150, earliestSellTs: 250 });
  assert.equal(p.costAvg, 11);
  assert.equal(p.earliestSellTs, 250);
});

test('sell applies fees, realizes pnl and enforces settlement', () => {
  const a = createAccount({ currency: 'CNY', initial: 100000 });
  applyBuy(a, { symbol: 'x', qty: 100, price: 10, fee: 5, ts: 100, earliestSellTs: 200 });
  assert.throws(() => applySell(a, { symbol: 'x', qty: 100, price: 11, fee: 5, ts: 150 }), /settlement/);
  const r = applySell(a, { symbol: 'x', qty: 100, price: 11, fee: 5, ts: 300 });
  assert.equal(r.realized, 100 - 5);
  assert.equal(a.cash, 100000 - 1005 + 1100 - 5);
  assert.equal(positionOf(a, 'x'), null);
  assert.throws(() => applySell(a, { symbol: 'x', qty: 1, price: 11, ts: 400 }), /no position/);
});

test('insufficient cash and oversell are rejected', () => {
  const a = createAccount({ currency: 'CNY', initial: 100 });
  assert.throws(() => applyBuy(a, { symbol: 'y', qty: 100, price: 10 }), /insufficient cash/);
  applyBuy(a, { symbol: 'y', qty: 10, price: 10, ts: 0, earliestSellTs: 0 });
  assert.throws(() => applySell(a, { symbol: 'y', qty: 20, price: 10, ts: 1 }), /exceeds position/);
});

test('snapshot marks positions to market and separates today pnl', () => {
  const a = createAccount({ currency: 'CNY', initial: 100000 });
  applyBuy(a, { symbol: 's', qty: 100, price: 10, fee: 0, ts: 0, earliestSellTs: 0 });
  const snap = snapshotOf(a, s => (s === 's' ? 12 : null), s => (s === 's' ? 11 : null));
  assert.equal(snap.positionsValue, 1200);
  assert.equal(snap.holdingPnl, 200);
  assert.equal(snap.todayPnl, 100);
  assert.equal(snap.totalPnl, 200);
  assert.equal(snap.totalValue, 100000 - 1000 + 1200);
});
