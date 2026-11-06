import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseStrategy, baselineStrategy, buildPrompt } from '../lib/strategist.js';
import { shouldReflect, stabilityCheck, recordOutcome, createVersion } from '../lib/reflector.js';

test('extractJson pulls object from fenced block', () => {
  const text = '分析如下：\n```json\n{"action":"buy","amountRmb":2000,"reason":"央行增持","confidence":0.7,"horizonHours":24}\n```\n以上。';
  const obj = extractJson(text);
  assert.equal(obj.action, 'buy');
  assert.equal(obj.amountRmb, 2000);
});

test('extractJson pulls bare object', () => {
  const obj = extractJson('前置 {"action":"sell","grams":5,"reason":"止盈","confidence":0.6,"horizonHours":12} 后缀');
  assert.equal(obj.action, 'sell');
  assert.equal(obj.grams, 5);
});

test('extractJson returns null on garbage', () => {
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('{bad json}'), null);
});

test('parseStrategy validates action and fields', () => {
  const ok = parseStrategy({ action: 'buy', amountRmb: 2000, reason: 'r', confidence: 0.8, horizonHours: 24 });
  assert.equal(ok.action, 'buy');
  assert.equal(ok.amountRmb, 2000);
  assert.equal(parseStrategy({ action: 'hold', reason: 'r' }).action, 'hold');
  assert.equal(parseStrategy({ action: 'manipulate', reason: 'r' }), null);
  assert.equal(parseStrategy(null), null);
  assert.equal(parseStrategy({ action: 'buy' }), null); // reason required
});

test('parseStrategy normalizes unknown fields away', () => {
  const s = parseStrategy({ action: 'buy', amountRmb: 1000, reason: 'r', confidence: 0.5, extra: 'x' });
  assert.equal(s.extra, undefined);
});

test('baselineStrategy buys on dip with momentum intact', () => {
  const s = baselineStrategy({
    summary: { changePct: -2.5, last: 840, ma: 850, volatility: 2 },
    position: { grams: 0 },
  });
  assert.equal(s.action, 'buy');
  const hold = baselineStrategy({
    summary: { changePct: 0.1, last: 850, ma: 850, volatility: 2 },
    position: { grams: 5 },
  });
  assert.equal(hold.action, 'hold');
});

test('buildPrompt includes position, news and rules', () => {
  const prompt = buildPrompt({
    summary: { changePct: 1, last: 850, ma: 845, volatility: 3, high: 855, low: 838 },
    position: { grams: 39.8934, costAvg: 877.34, marketValue: 33750.22, holdingPnl: -1249.78 },
    news: [{ title: '央行增持黄金' }],
    stats: { trades: 8, returnPct: -1.2, winRate: 0.4 },
    cfg: { perTradeLimitRmb: 5000, totalLimitRmb: 100000 },
  });
  assert.match(prompt, /央行增持黄金/);
  assert.match(prompt, /39\.8934/);
  assert.match(prompt, /5000/);
  assert.match(prompt, /100000/);
});

test('shouldReflect triggers on version loss pct', () => {
  const cfg = { reflectLossPct: -3, reflectConsecLosses: 3, reflectMaxDrawdownPct: -8 };
  assert.equal(shouldReflect({ returnPct: -4, consecLosses: 1, maxDrawdownPct: -2 }, cfg), true);
  assert.equal(shouldReflect({ returnPct: 1, consecLosses: 1, maxDrawdownPct: -2 }, cfg), false);
});

test('shouldReflect triggers on consecutive losses and drawdown', () => {
  const cfg = { reflectLossPct: -3, reflectConsecLosses: 3, reflectMaxDrawdownPct: -8 };
  assert.equal(shouldReflect({ returnPct: -1, consecLosses: 3, maxDrawdownPct: -2 }, cfg), true);
  assert.equal(shouldReflect({ returnPct: -1, consecLosses: 1, maxDrawdownPct: -9 }, cfg), true);
});

test('stabilityCheck flags reference-worthy versions', () => {
  const cfg = { stableMinTrades: 5, stableMaxDrawdownPct: -5, stableMinReturnPct: 0 };
  assert.equal(stabilityCheck({ trades: 8, returnPct: 2.5, maxDrawdownPct: -3 }, cfg), true);
  assert.equal(stabilityCheck({ trades: 4, returnPct: 2.5, maxDrawdownPct: -3 }, cfg), false);
  assert.equal(stabilityCheck({ trades: 8, returnPct: -0.1, maxDrawdownPct: -3 }, cfg), false);
  assert.equal(stabilityCheck({ trades: 8, returnPct: 2.5, maxDrawdownPct: -6 }, cfg), false);
});

test('recordOutcome updates stats with win/loss streaks', () => {
  const v = createVersion(1, { action: 'hold' });
  recordOutcome(v, -100);
  recordOutcome(v, -50);
  recordOutcome(v, -10);
  assert.equal(v.consecLosses, 3);
  assert.equal(v.trades, 3);
  recordOutcome(v, 200);
  assert.equal(v.consecLosses, 0);
  assert.equal(v.wins, 1);
  assert.ok(v.returnPnl > 0);
});

test('recordOutcome tracks max drawdown from peak pnl', () => {
  const v = createVersion(1, {});
  recordOutcome(v, 100);
  recordOutcome(v, -250); // pnl -150 from peak 100 -> dd -250
  assert.equal(v.maxDrawdownPnl, -250);
});
