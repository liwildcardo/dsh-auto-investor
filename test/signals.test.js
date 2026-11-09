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

test('realYield signal: falling real yields are bullish for gold', () => {
  const mk = (delta5d, extra = {}) => ({ realYield: { delta5d, stale: false, ...extra } });
  assert.equal(evaluateSignals([{ id: 'realYield' }], mk(-0.20))[0].score, 2, '−20bp → +2');
  assert.equal(evaluateSignals([{ id: 'realYield' }], mk(-0.08))[0].score, 1, '−8bp → +1');
  assert.equal(evaluateSignals([{ id: 'realYield' }], mk(0.25))[0].score, -2, '+25bp → −2');
  assert.equal(evaluateSignals([{ id: 'realYield' }], mk(0.07))[0].score, -1, '+7bp → −1');
  assert.equal(evaluateSignals([{ id: 'realYield' }], mk(0.01))[0].score, 0, '+1bp → neutral');
  assert.equal(evaluateSignals([{ id: 'realYield' }], { realYield: { delta5d: -0.2, stale: true } })[0].score, 0, 'stale → neutral');
  assert.equal(evaluateSignals([{ id: 'realYield' }], {})[0].score, 0, 'missing → neutral');
});

test('usdIndex signal: a stronger dollar is bearish for gold', () => {
  const mk = (delta5d, extra = {}) => ({ usdIndex: { delta5d, stale: false, ...extra } });
  assert.equal(evaluateSignals([{ id: 'usdIndex' }], mk(-0.8))[0].score, 2, '−0.8% → +2');
  assert.equal(evaluateSignals([{ id: 'usdIndex' }], mk(-0.2))[0].score, 1, '−0.2% → +1');
  assert.equal(evaluateSignals([{ id: 'usdIndex' }], mk(0.9))[0].score, -2, '+0.9% → −2');
  assert.equal(evaluateSignals([{ id: 'usdIndex' }], mk(0.3))[0].score, -1, '+0.3% → −1');
  assert.equal(evaluateSignals([{ id: 'usdIndex' }], mk(0.05))[0].score, 0, 'flat → neutral');
  assert.equal(evaluateSignals([{ id: 'usdIndex' }], { usdIndex: { delta5d: -0.8, stale: true } })[0].score, 0, 'stale → neutral');
});

test('valuation signal keeps its percentile boundaries', () => {
  const ev = (p) => evaluateSignals([{ id: 'valuation', params: { low: 0.3, high: 0.8 } }], { pePercentile: p })[0];
  assert.equal(ev(0.2).score, 2);
  assert.equal(ev(0.4).score, 1);
  assert.equal(ev(0.9).score, -2);
  assert.equal(ev(0.7).score, -1);
  assert.equal(ev(0.55).score, 0);
  assert.equal(ev(undefined).score, 0, 'no data → score 0');
  assert.equal(ev(undefined).noData, true, 'no data → abstains (flagged)');
});

test('noData signals abstain instead of diluting the composite', () => {
  const evaluated = [
    { score: 2, weight: 1.2 },                       // informed technical signal
    { score: 0, weight: 0.6, noData: true },         // factor without data
    { score: -2, weight: 0.6, noData: true },        // stale factor must not push down either
  ];
  assert.equal(compositeScore(evaluated), 2, 'only the informed signal counts');
  assert.equal(compositeScore([{ score: 0, noData: true }]), 0, 'all abstain → 0');
});
