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

test('breakevenInflation signal thresholds（5日通胀预期变化 bp）', () => {
  const mk = (delta5d, extra = {}) => ({ breakeven: { delta5d, stale: false, ...extra } });
  const ev = (ctx, params) => evaluateSignals([{ id: 'breakevenInflation', params }], ctx)[0];
  assert.equal(ev(mk(-0.12)).score, -2, '−12bp → −2');
  assert.equal(ev(mk(-0.04)).score, -1, '−4bp → −1');
  assert.equal(ev(mk(0.12)).score, 2, '+12bp → +2');
  assert.equal(ev(mk(0.02)).score, 0, '+2bp → 中性');
  assert.equal(ev(mk(0.12, { stale: true })).noData, true, 'stale → 弃权');
  assert.equal(ev({}).noData, true, 'missing → 弃权');
});

test('yieldCurve signal direction parameter（倒挂/陡峭 × 方向）', () => {
  const mk = (value, extra = {}) => ({ yieldCurve: { value, stale: false, ...extra } });
  const ev = (ctx, params) => evaluateSignals([{ id: 'yieldCurve', params }], ctx)[0];
  assert.equal(ev(mk(-0.3)).score, 2, '倒挂 → +2（默认 direction 1）');
  assert.equal(ev(mk(-0.3), { direction: -1 }).score, -2, 'direction −1 反号');
  assert.equal(ev(mk(1.2)).score, 0, '正常斜率 → 中性');
  assert.equal(ev(mk(3.0)).score, -1, '过度陡峭 → −1');
  assert.equal(ev({}).noData, true, 'missing → 弃权');
  assert.equal(ev(mk(NaN)).noData, true, '非有限 slope → 弃权');
});

test('goldSilverRatio signal thresholds（金银比 5 日变化 %）', () => {
  const mk = (delta5d, extra = {}) => ({ goldSilverRatio: { delta5d, stale: false, ...extra } });
  const ev = (ctx, params) => evaluateSignals([{ id: 'goldSilverRatio', params }], ctx)[0];
  assert.equal(ev(mk(5.2)).score, 2, '+5.2% → +2');
  assert.equal(ev(mk(1.8)).score, 1, '+1.8% → +1');
  assert.equal(ev(mk(-1.8)).score, -1, '−1.8% → −1');
  assert.equal(ev(mk(-5.2)).score, -2, '−5.2% → −2');
  assert.equal(ev(mk(0.5)).score, 0, '0.5% → 中性');
  assert.equal(ev(mk(5.2), { direction: -1 }).score, -2, 'direction −1 反号');
  assert.equal(ev(mk(5.2, { stale: true })).noData, true, 'stale → 弃权');
  assert.equal(ev({}).noData, true, 'missing → 弃权');
});

test('valuation PE/PB 复合：两源平均、单源回退、双缺弃权', () => {
  const ev = (ctx, params = { low: 0.3, high: 0.8 }) =>
    evaluateSignals([{ id: 'valuation', params }], ctx)[0];
  // 两源皆高分 → 平均仍为 +2
  assert.equal(ev({ pePercentile: 0.2, pbPercentile: 0.1 }).score, 2, '双高 → +2');
  // 真正的平均：pe +1（0.4）与 pb +2（0.2）→ 1.5
  assert.equal(ev({ pePercentile: 0.4, pbPercentile: 0.2 }).score, 1.5, '异分取平均');
  // 只有 PE：与旧逻辑逐位一致（pb 缺失不稀释）
  assert.equal(ev({ pePercentile: 0.2, pbPercentile: undefined }).score, 2, 'pe-only 与旧一致');
  assert.equal(ev({ pePercentile: 0.4 }).score, 1, 'pe-only 中档');
  // 只有 PB
  assert.equal(ev({ pePercentile: undefined, pbPercentile: 0.9 }).score, -2, 'pb-only 也生效');
  // 双缺 → 弃权
  const none = ev({});
  assert.equal(none.score, 0);
  assert.equal(none.noData, true, '双缺 → noData');
  // null 视为缺数据（历史 Number(null)=0 → +2 是缺陷，不再复现）
  assert.equal(ev({ pePercentile: null, pbPercentile: null }).noData, true, '双 null → noData');
});

test('valuation note 恢复档位词（分数不变）', () => {
  const ev = (ctx) => evaluateSignals([{ id: 'valuation', params: { low: 0.3, high: 0.8 } }], ctx)[0];
  assert.equal(ev({ pePercentile: 0.2 }).note, 'PE 分位 20% 偏低');
  assert.equal(ev({ pePercentile: 0.4 }).note, 'PE 分位 40% 中低');
  assert.equal(ev({ pePercentile: 0.9 }).note, 'PE 分位 90% 偏高');
  assert.equal(ev({ pePercentile: 0.7 }).note, 'PE 分位 70% 中高');
  assert.equal(ev({ pePercentile: 0.55 }).note, 'PE 分位 55%', '中性档无后缀');
  assert.equal(
    ev({ pePercentile: 0.2, pbPercentile: 0.1 }).note,
    'PE 分位 20% 偏低 / PB 分位 10% 偏低',
    '双源各自带档位词',
  );
  assert.equal(ev({ pePercentile: 0.2 }).score, 2, '分数不变');
});

test('新信号 note 带方向说明（利好/利空黄金、金银比强弱）', () => {
  const be = (bp) => evaluateSignals([{ id: 'breakevenInflation' }], { breakeven: { delta5d: bp, stale: false } })[0];
  assert.match(be(0.12).note, /利好黄金/, '预期上行 → 利好');
  assert.match(be(-0.12).note, /利空黄金/, '预期下行 → 利空');
  assert.doesNotMatch(be(0.01).note, /利好黄金|利空黄金/, '中性不加方向词');
  const gs = (p) => evaluateSignals([{ id: 'goldSilverRatio' }], { goldSilverRatio: { delta5d: p, stale: false } })[0];
  assert.match(gs(5.2).note, /走强/, '比值上行 → 黄金相对走强');
  assert.match(gs(-5.2).note, /走弱/, '比值下行 → 黄金相对走弱');
});
