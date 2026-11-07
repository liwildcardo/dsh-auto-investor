/**
 * 通用指标与信号库：所有产品共用，靠参数化表达"投资逻辑的不同"。
 * 每个信号返回 {id, score: -2..+2, note}，综合分 = 加权平均。
 */

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Rate of change over `period` bars (fraction, not percent). */
export function roc(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    const base = values[i - period];
    if (base > 0) out[i] = (values[i] - base) / base;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Sample standard deviation of simple returns over the trailing window. */
export function volatility(values, window = 20) {
  const rets = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] > 0) rets.push(values[i] / values[i - 1] - 1);
  }
  if (rets.length < 2) return null;
  const slice = rets.slice(-window);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const varSum = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
  return Math.sqrt(varSum);
}

/** Latest volume / trailing average volume. */
export function volumeRatio(volumes, period = 20) {
  const v = volumes.filter(x => Number.isFinite(x));
  if (v.length <= period) return null;
  const avg = v.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return avg > 0 ? last(v) / avg : null;
}

const clampScore = (x) => Math.max(-2, Math.min(2, x));

/* ---------------- signal rules (each: (ctx, params) => {score, note}) ---------------- */

function trendSignal(ctx, params = {}) {
  const fast = params.fast ?? 5;
  const slow = params.slow ?? 20;
  const closes = ctx.series ?? [];
  if (closes.length < slow + 2) return { score: 0, note: '数据不足' };
  const f = sma(closes, fast);
  const s = sma(closes, slow);
  const fNow = last(f);
  const sNow = last(s);
  const sPrev = s[s.length - 2];
  if (!Number.isFinite(fNow) || !Number.isFinite(sNow) || !Number.isFinite(sPrev)) return { score: 0, note: '数据不足' };
  const slope = (sNow - sPrev) / sPrev;
  const above = fNow > sNow;
  const rising = slope > 0;
  if (above && rising) return { score: 2, note: `快线>慢线且慢线上行(${(slope * 100).toFixed(2)}%)` };
  if (above) return { score: 1, note: '快线>慢线但慢线走平/下行' };
  if (!above && !rising) return { score: -2, note: `快线<慢线且慢线下行(${(slope * 100).toFixed(2)}%)` };
  return { score: -1, note: '快线<慢线但慢线走平/上行' };
}

function momentumSignal(ctx, params = {}) {
  const closes = ctx.series ?? [];
  const period = params.period ?? 10;
  const r = last(roc(closes, period));
  if (!Number.isFinite(r)) return { score: 0, note: '数据不足' };
  const thr = params.threshold ?? 0.02;
  const score = clampScore(Math.round((r / thr) * 1.5) / 1.5);
  return { score, note: `${period}日涨跌 ${(r * 100).toFixed(2)}%` };
}

function rsiSignal(ctx, params = {}) {
  const closes = ctx.series ?? [];
  const period = params.period ?? 14;
  const v = last(rsi(closes, period));
  if (!Number.isFinite(v)) return { score: 0, note: '数据不足' };
  if (v >= (params.overbought ?? 75)) return { score: -2, note: `RSI ${v.toFixed(1)} 超买` };
  if (v <= (params.oversold ?? 25)) return { score: 2, note: `RSI ${v.toFixed(1)} 超卖` };
  if (v > 60) return { score: 0.5, note: `RSI ${v.toFixed(1)} 偏强` };
  if (v < 40) return { score: -0.5, note: `RSI ${v.toFixed(1)} 偏弱` };
  return { score: 0, note: `RSI ${v.toFixed(1)} 中性` };
}

function breakoutSignal(ctx, params = {}) {
  const closes = ctx.series ?? [];
  const look = params.lookback ?? 20;
  if (closes.length < look + 1) return { score: 0, note: '数据不足' };
  const window = closes.slice(-look - 1, -1);
  const high = Math.max(...window);
  const low = Math.min(...window);
  const price = last(closes);
  if (price > high) return { score: 2, note: `突破 ${look} 日高点 ${high.toFixed(2)}` };
  if (price < low) return { score: -2, note: `跌破 ${look} 日低点 ${low.toFixed(2)}` };
  return { score: 0, note: `${look} 日区间内` };
}

function volumeSignal(ctx, params = {}) {
  const r = volumeRatio(ctx.volumes ?? [], params.period ?? 20);
  if (!r) return { score: 0, note: '数据不足' };
  const closes = ctx.series ?? [];
  const up = closes.length > 1 && last(closes) > closes[closes.length - 2];
  const hot = r >= (params.hot ?? 1.5);
  if (hot && up) return { score: 1, note: `放量上涨(量比 ${r.toFixed(2)})` };
  if (hot && !up) return { score: -1, note: `放量下跌(量比 ${r.toFixed(2)})` };
  return { score: 0, note: `量比 ${r.toFixed(2)}` };
}

function valuationSignal(ctx, params = {}) {
  const p = Number(ctx.pePercentile);
  if (!Number.isFinite(p)) return { score: 0, note: '无估值数据' };
  const low = params.low ?? 0.3;
  const high = params.high ?? 0.8;
  if (p <= low) return { score: 2, note: `PE 分位 ${(p * 100).toFixed(0)}% 偏低` };
  if (p < 0.5) return { score: 1, note: `PE 分位 ${(p * 100).toFixed(0)}% 中低` };
  if (p >= high) return { score: -2, note: `PE 分位 ${(p * 100).toFixed(0)}% 偏高` };
  if (p > 0.65) return { score: -1, note: `PE 分位 ${(p * 100).toFixed(0)}% 中高` };
  return { score: 0, note: `PE 分位 ${(p * 100).toFixed(0)}%` };
}

const POSITIVE = ['上涨', '增持', '突破', '利好', '超预期', '增长', '回购', '分红', '降息', '宽松', '创新高'];
const NEGATIVE = ['下跌', '减持', '跌破', '利空', '不及预期', '下滑', '处罚', '违约', '加息', '收紧'];

function newsSentimentSignal(ctx, params = {}) {
  const titles = (ctx.news ?? []).map(n => String(n.title ?? ''));
  if (!titles.length) return { score: 0, note: '无资讯' };
  let score = 0;
  for (const t of titles) {
    for (const w of POSITIVE) if (t.includes(w)) score += 0.5;
    for (const w of NEGATIVE) if (t.includes(w)) score -= 0.5;
  }
  const cap = params.cap ?? 2;
  const s = Math.max(-cap, Math.min(cap, score / Math.max(1, titles.length / 3)));
  return { score: Math.round(s * 10) / 10, note: `资讯情绪 ${s > 0 ? '+' : ''}${s.toFixed(1)}` };
}

export const SIGNALS = {
  trend: trendSignal,
  momentum: momentumSignal,
  rsi: rsiSignal,
  breakout: breakoutSignal,
  volume: volumeSignal,
  valuation: valuationSignal,
  news: newsSentimentSignal,
};

/** Evaluate one product's configured signals against a market snapshot. */
export function evaluateSignals(signals, ctx) {
  const out = [];
  for (const s of signals ?? []) {
    const fn = SIGNALS[s.id];
    if (!fn) continue;
    const { score, note } = fn(ctx, s.params ?? {}) ?? { score: 0, note: '' };
    out.push({ id: s.id, score, note, weight: s.weight ?? 1 });
  }
  return out;
}

/** Weighted average score → -2..+2. */
export function compositeScore(evaluated) {
  const list = evaluated ?? [];
  const w = list.reduce((a, s) => a + Math.abs(s.weight ?? 1), 0);
  if (!w) return 0;
  const sum = list.reduce((a, s) => a + (s.score ?? 0) * (s.weight ?? 1), 0);
  return Math.round((sum / w) * 100) / 100;
}

/** Candidate selection: positive composite score above threshold, best first. */
export function pickCandidates(scored, params = {}) {
  const threshold = params.threshold ?? 0.8;
  const topN = params.topN ?? 5;
  return (scored ?? [])
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
