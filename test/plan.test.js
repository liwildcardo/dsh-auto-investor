import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStrategy, buildPrompt, baselineStrategy } from '../lib/strategist.js';
import { resolvePlan } from '../lib/strategist.js';
import { resolveConfig } from '../lib/config.js';

// frequency plan is part of the strategy (issue: it should be a strategy element)

test('parseStrategy accepts a frequency plan in the decision', () => {
  const s = parseStrategy({
    action: 'buy', amountRmb: 3000, reason: 'r',
    plan: { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 6, maxPositionPct: 30 },
  });
  assert.equal(s.plan.style, 'swing');
  assert.equal(s.plan.maxTradesPerDay, 2);
  assert.equal(s.plan.minIntervalHours, 6);
});

test('parseStrategy rejects malformed plans but keeps the decision', () => {
  const s = parseStrategy({ action: 'hold', reason: 'r', plan: { maxTradesPerDay: -5, minIntervalHours: 'x' } });
  assert.equal(s.action, 'hold');
  assert.equal(s.plan, undefined);
});

test('resolvePlan clamps to global hard caps', () => {
  const cfg = resolveConfig({});
  const p = resolvePlan({ style: 'day', maxTradesPerDay: 99, minIntervalHours: 0 }, cfg);
  assert.ok(p.maxTradesPerDay <= cfg.hardMaxTradesPerDay, `got ${p.maxTradesPerDay}`);
  assert.ok(p.minIntervalHours >= cfg.hardMinIntervalHours, `got ${p.minIntervalHours}`);
});

test('resolvePlan falls back to default swing plan', () => {
  const cfg = resolveConfig({});
  const p = resolvePlan(undefined, cfg);
  assert.equal(p.style, 'swing');
  assert.ok(p.maxTradesPerDay >= 1);
  assert.ok(p.minIntervalHours >= 1);
});

test('buildPrompt mentions frequency rules and investment style', () => {
  const cfg = resolveConfig({});
  const prompt = buildPrompt({
    summary: { changePct: 1, last: 850, ma: 845, volatility: 3, high: 855, low: 838 },
    position: { grams: 10, costAvg: 870, marketValue: 8500, holdingPnl: -200 },
    news: [], stats: {}, plan: { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 4 },
  }, cfg);
  assert.match(prompt, /频率|frequency/);
  assert.match(prompt, /swing|波段/);
});

test('baselineStrategy declares its own frequency plan', () => {
  const s = baselineStrategy({ summary: { changePct: -2.5, last: 840, ma: 850, volatility: 2 }, position: { grams: 0 } });
  assert.ok(s.plan, 'baseline must carry a plan');
  assert.ok(s.plan.maxTradesPerDay >= 1);
});
