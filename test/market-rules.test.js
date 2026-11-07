import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProducts } from '../core/registry.js';
import {
  isSessionOpen, roundLot, tradeFees, earliestSellTs, priceLimitBand, withinPriceBand, zonedParts,
} from '../core/market-rules.js';

const P = Object.fromEntries(loadProducts().map(p => [p.id, p]));
const TS = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h, min);

test('A股费用：佣金万分之2.5最低5元，卖出印花税0.05%，双边过户费', () => {
  const buy = tradeFees(P.ashare.rules, 'buy', 10000);
  assert.equal(buy.commission, 5);           // 10000*0.00025 = 2.5 → min 5
  assert.equal(buy.stampDuty, 0);
  assert.ok(Math.abs(buy.transferFee - 0.1) < 1e-9);
  const sell = tradeFees(P.ashare.rules, 'sell', 100000);
  assert.equal(sell.commission, 25);
  assert.equal(sell.stampDuty, 50);
  assert.ok(Math.abs(sell.total - (25 + 50 + 1)) < 1e-6);
});

test('港股费用：佣金0.25%最低HK$100，双边印花税0.1%，交易/结算费', () => {
  const buy = tradeFees(P.hk.rules, 'buy', 10000);
  assert.equal(buy.commission, 100);          // 10000*0.0025 = 25 → min 100
  assert.equal(buy.stampDuty, 10);            // 双边都收
  assert.ok(Math.abs(buy.regulator - 10000 * (0.0000565 + 0.00002)) < 1e-9);
  const sell = tradeFees(P.hk.rules, 'sell', 10000);
  assert.equal(sell.stampDuty, 10);
});

test('美股费用可为零，黄金走点差无显式费用', () => {
  assert.equal(tradeFees(P.us.rules, 'buy', 5000).total, 0);
  assert.equal(tradeFees(P.gold.rules, 'sell', 5000).total, 0);
});

test('手数：A股100股整数倍、美股整股、黄金可小数克', () => {
  assert.equal(roundLot(P.ashare.rules, 1234), 1200);
  assert.equal(roundLot(P.us.rules, 12.9), 12);
  assert.equal(roundLot(P.gold.rules, 3.45678), 3.456);
});

test('交易时段：A股午休关闭、黄金跨夜开放、美股夏令时正确', () => {
  // 2026-11-06 Friday
  assert.equal(isSessionOpen(P.ashare.rules, TS(2026, 11, 6, 2, 0), P.ashare.timezone), true);   // 10:00 上海
  assert.equal(isSessionOpen(P.ashare.rules, TS(2026, 11, 6, 4, 0), P.ashare.timezone), false);  // 12:00 午休
  assert.equal(isSessionOpen(P.ashare.rules, TS(2026, 11, 7, 2, 0), P.ashare.timezone), false);  // 周六
  assert.equal(isSessionOpen(P.gold.rules, TS(2026, 11, 6, 15, 30), P.gold.timezone), true);    // 23:30 上海
  assert.equal(isSessionOpen(P.gold.rules, TS(2026, 11, 8, 15, 30), P.gold.timezone), false);   // 周六夜
  // 美股：冬季 10:00 EST = 15:00 UTC；夏季 10:00 EDT = 14:00 UTC
  assert.equal(isSessionOpen(P.us.rules, TS(2026, 11, 6, 15, 0), P.us.timezone), true);
  assert.equal(isSessionOpen(P.us.rules, TS(2026, 7, 6, 14, 0), P.us.timezone), true);
  assert.equal(isSessionOpen(P.us.rules, TS(2026, 11, 6, 22, 0), P.us.timezone), false);        // 17:00 EST 收盘后
});

test('结算：A股T+1跳过周末、港股T+2、黄金T+0', () => {
  const friday = TS(2026, 11, 6, 2, 0);
  const aSell = earliestSellTs(friday, P.ashare.rules, P.ashare.timezone);
  const aDay = zonedParts(aSell, P.ashare.timezone);
  assert.equal(aDay.date, '2026-11-09'); // 周五买入 → 下周一可卖
  assert.equal(aDay.minutes, 570, 'unlocks at the next session open (09:30), not buy time + 24h');
  // 美股/港股允许日内交易：结算日不影响卖出
  assert.equal(earliestSellTs(friday, P.us.rules, P.us.timezone), friday);
  assert.equal(earliestSellTs(friday, P.hk.rules, P.hk.timezone), friday);
  assert.equal(earliestSellTs(friday, P.gold.rules, P.gold.timezone), friday);
});

test('T+2 结算市场在关闭日内交易时仍在第二个交易日解锁', () => {
  const rules = { ...P.hk.rules, allowSameDaySell: false };
  const monday = TS(2026, 11, 9, 2, 0);
  const unlock = earliestSellTs(monday, rules, P.hk.timezone);
  assert.equal(zonedParts(unlock, P.hk.timezone).date, '2026-11-11');
});

test('涨跌停：A股±10%限制、美股无限制', () => {
  const band = priceLimitBand(P.ashare.rules, 10);
  assert.equal(band.up, 11);
  assert.equal(band.down, 9);
  assert.equal(withinPriceBand(P.ashare.rules, 10, 11), true);
  assert.equal(withinPriceBand(P.ashare.rules, 10, 11.01), false);
  assert.equal(withinPriceBand(P.us.rules, 100, 500), true);
});

test('涨跌停按板块区分：创业板/科创板 ±20%，主板 ±10%', () => {
  assert.equal(priceLimitBand(P.ashare.rules, 10, 'sz300750').up, 12);
  assert.equal(priceLimitBand(P.ashare.rules, 10, 'sh688981').up, 12);
  assert.equal(priceLimitBand(P.ashare.rules, 10, 'sh600519').up, 11);
});

test('港股按每手股数成交', () => {
  assert.equal(roundLot(P.hk.rules, 150, 'hk00941'), 0);   // 500 股/手
  assert.equal(roundLot(P.hk.rules, 600, 'hk00941'), 500);
  assert.equal(roundLot(P.hk.rules, 250, 'hk01810'), 200); // 200 股/手
});
