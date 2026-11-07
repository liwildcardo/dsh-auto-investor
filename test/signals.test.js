import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, roc, rsi, volatility, volumeRatio,
  evaluateSignals, compositeScore, pickCandidates,
} from '../core/signals.js';

test('sma/ema/roc basic math', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3], 2);
  assert.equal(e[0], 1);
  assert.ok(Math.abs(e[1] - (2 * (2 / 3) + 1 * (1 / 3))) < 1e-9);
  assert.equal(roc([100, 110], 1)[1], 0.1);
});

test('rsi detects oversold and overbought', () => {
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.ok(rsi(down, 14).at(-1) < 10);
  assert.ok(rsi(up, 14).at(-1) > 90);
});

test('volatility and volumeRatio', () => {
  assert.equal(volatility([100], 20), null);
  assert.ok(volatility([100, 101, 100, 101, 100], 20) > 0);
  assert.ok(volumeRatio([100, 100, 100, 200], 3) > 1.9);
});

test('trend signal scores a rising series positively', () => {
  const series = Array.from({ length: 40 }, (_, i) => 100 + i);
  const out = evaluateSignals([{ id: 'trend', params: { fast: 5, slow: 20 }, weight: 1 }], { series });
  assert.equal(out[0].score, 2);
  const fall = Array.from({ length: 40 }, (_, i) => 200 - i);
  const down = evaluateSignals([{ id: 'trend', params: { fast: 5, slow: 20 } }], { series: fall });
  assert.equal(down[0].score, -2);
});

test('valuation and news signals respond to inputs', () => {
  const cheap = evaluateSignals([{ id: 'valuation', params: { low: 0.3, high: 0.8 } }], { pePercentile: 0.1 });
  assert.equal(cheap[0].score, 2);
  const rich = evaluateSignals([{ id: 'valuation', params: { low: 0.3, high: 0.8 } }], { pePercentile: 0.95 });
  assert.equal(rich[0].score, -2);
  const good = evaluateSignals([{ id: 'news' }], { news: [{ title: '公司回购并提高分红' }] });
  assert.ok(good[0].score > 0);
});

test('composite score is a weighted average, candidates are ranked', () => {
  const score = compositeScore([
    { score: 2, weight: 2 }, { score: 0, weight: 1 }, { score: -1, weight: 1 },
  ]);
  assert.equal(score, 0.75);
  const picked = pickCandidates([
    { symbol: 'a', score: 1.5 }, { symbol: 'b', score: 0.9 }, { symbol: 'c', score: 0.2 },
  ], { threshold: 0.8, topN: 5 });
  assert.deepEqual(picked.map(x => x.symbol), ['a', 'b']);
});
