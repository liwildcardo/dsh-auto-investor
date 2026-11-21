import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolio, buy, sell, snapshot, toTerm, fromTerm, settleDemandYield } from '../lib/portfolio.js';

// Screenshot vectors (招行黄金账户):
// 持仓克重=39.8934克, 成本均价=877.34元/克, 卖出价=846.01
// 持仓金额=33,750.22 (= sell × grams); 持仓收益=-1,249.78; 今日收益(Δ0.73)=29.13

function screenshotPortfolio() {
  const p = createPortfolio(100000);
  // emulate a fill history that lands on costAvg ≈ 877.34 and 39.8934 grams
  buy(p, 20000, 880.0);
  buy(p, 15000, 873.0);
  // normalize to the exact screenshot totals for vector checking
  p.grams = 39.8934;
  p.costAvg = 877.34;
  p.investedRmb = 39.8934 * 877.34;
  return p;
}

test('snapshot reproduces screenshot accounting', () => {
  const p = screenshotPortfolio();
  const s = snapshot(p, { sell: 846.01, buy: 851.01 }, { sell: 845.28, buy: 850.28 });
  assert.ok(Math.abs(s.marketValue - 33750.22) < 0.05, `marketValue=${s.marketValue}`);
  assert.ok(Math.abs(s.holdingPnl - (-1249.78)) < 0.5, `holdingPnl=${s.holdingPnl}`);
  assert.ok(Math.abs(s.todayPnl - 29.13) < 0.5, `todayPnl=${s.todayPnl}`);
  assert.equal(s.grams, 39.8934);
  assert.equal(s.costAvg, 877.34);
});

test('buy adds grams at buy price and updates cost avg', () => {
  const p = createPortfolio(100000);
  buy(p, 1000, 850); // 1000/850 g
  const expectedG = 1000 / 850;
  assert.ok(Math.abs(p.grams - expectedG) < 1e-9);
  assert.ok(Math.abs(p.costAvg - 850) < 1e-9);
  buy(p, 1000, 870);
  assert.ok(Math.abs(p.grams - (1000 / 850 + 1000 / 870)) < 1e-9);
  assert.ok(p.costAvg > 850 && p.costAvg < 870);
});

test('sell reduces grams and realizes PnL at sell price', () => {
  const p = createPortfolio(100000);
  buy(p, 1000, 850);
  const before = p.grams;
  const proceeds = sell(p, 0.5, 900);
  assert.ok(Math.abs(proceeds - 450) < 1e-9);
  assert.ok(Math.abs(p.grams - (before - 0.5)) < 1e-9);
  // realized = (900-850) * 0.5 = 25
  assert.ok(Math.abs(p.realizedPnl - 25) < 1e-6, `realized=${p.realizedPnl}`);
});

test('snapshot totals = realized + unrealized', () => {
  const p = createPortfolio(100000);
  buy(p, 1000, 850);
  sell(p, 0.5, 900);
  const s = snapshot(p, { sell: 860, buy: 865 }, null);
  assert.ok(Math.abs(s.totalPnl - (s.realizedPnl + s.holdingPnl)) < 1e-6);
});

test('toTerm/fromTerm move grams between buckets', () => {
  const p = createPortfolio(100000);
  buy(p, 20000, 850);
  toTerm(p, 10);
  assert.equal(p.termGrams, 10);
  assert.ok(p.grams < 20000 / 850);
  fromTerm(p, 4);
  assert.equal(p.termGrams, 6);
});

test('settleDemandYield credits grams by annual pct', () => {
  const p = createPortfolio(100000);
  buy(p, 1000, 850);
  const g0 = p.grams;
  settleDemandYield(p, 0.35, 365); // one year of 0.35%
  const credited = p.grams - g0;
  assert.ok(Math.abs(credited - g0 * 0.0035) < 1e-9, `credited=${credited}`);
});

test('empty portfolio snapshots to zero', () => {
  const p = createPortfolio(100000);
  const s = snapshot(p, { sell: 846.01, buy: 851.01 }, { sell: 845.28 });
  assert.equal(s.marketValue, 0);
  assert.equal(s.holdingPnl, 0);
  assert.equal(s.todayPnl, 0);
});

test('todayPnl is measured against the day-open quote, not the previous tick', () => {
  const p = createPortfolio(100000);
  buy(p, 2000, 851.01);
  const grams = p.grams;
  const dayOpen = { sell: 860, buy: 865 };
  const prevTick = { sell: 855, buy: 860 };
  const now = { sell: 850, buy: 855 };
  // caller passes the day-open quote as the baseline
  const s = snapshot(p, now, dayOpen);
  assert.ok(Math.abs(s.todayPnl - (850 - 860) * grams) < 0.01, `todayPnl=${s.todayPnl}`);
  // prove it differs from tick-over-tick
  const wrong = snapshot(p, now, prevTick);
  assert.ok(Math.abs(wrong.todayPnl - s.todayPnl) > 1);
});

test('cold/no-quote snapshot reports cost basis instead of a fake total loss', () => {
  const p = createPortfolio(100000);
  buy(p, 2000, 850);
  const s = snapshot(p, null, null);
  assert.equal(s.noQuote, true);
  assert.ok(Math.abs(s.marketValue - 2000) < 1e-6, `marketValue=${s.marketValue}`);
  assert.equal(s.holdingPnl, 0);
  assert.equal(s.todayPnl, 0);
  assert.ok(s.totalPnl > -1, 'no fabricated -13000 loss');
});
