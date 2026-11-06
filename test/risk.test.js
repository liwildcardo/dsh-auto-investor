import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';
import { validateTrade } from '../lib/rules.js';
import { createPortfolio, buy } from '../lib/portfolio.js';
import { stabilityCheck } from '../lib/reflector.js';

function harness(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-risk-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const cfg = resolveConfig({});
  let clock = Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 SH
  const prices = opts.prices ?? [4090];
  let idx = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('gold-api')) {
      const price = prices[Math.min(idx, prices.length - 1)];
      idx += 1;
      return { ok: true, json: async () => ({ price }) };
    }
    return { ok: true, json: async () => ({ rates: { CNY: 7 } }), text: async () => '<rss></rss>' };
  };
  const llm = opts.llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 }));
  const svc = createService({ db, cfg, fetchFn, llm, now: () => clock });
  return { svc, db, cfg, setClock: (c) => { clock = c; } };
}

test('stop-loss liquidates the full position when the hard floor is breached', async (t) => {
  const { svc, setClock } = harness(t, { prices: [4090, 3800] });
  await svc.tickPrices(); // buy price ~922.9
  svc.manualTrade({ side: 'buy', rmb: 5000 });
  const before = svc.status().portfolio.grams;
  assert.ok(before > 0);
  setClock(Date.UTC(2026, 10, 2, 3, 0));
  await svc.tickPrices(); // ~852.7 sell -> ~-7.6% holding, past -5% hard floor
  const risk = svc.riskCheck();
  assert.equal(risk.kind, 'stopLoss', JSON.stringify(risk));
  assert.equal(svc.status().portfolio.grams, 0, 'position fully liquidated');
});

test('take-profit sells half the position when the plan target is hit', async (t) => {
  const { svc, setClock } = harness(t, { prices: [4000, 4400] });
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 5000 });
  const before = svc.status().portfolio.grams;
  setClock(Date.UTC(2026, 10, 2, 3, 0));
  await svc.tickPrices(); // ~+10% -> past plan takeProfitPct 6
  const risk = svc.riskCheck();
  assert.equal(risk.kind, 'takeProfit', JSON.stringify(risk));
  const after = svc.status().portfolio.grams;
  assert.ok(after < before && after > 0, `expected partial sell, got ${before} -> ${after}`);
});

test('max position pct is enforced on buy', () => {
  const cfg = resolveConfig({});
  const p = createPortfolio(cfg.initialCapitalRmb);
  buy(p, 56000, 850); // ~56k exposure (below 60% of 100k)
  const r = validateTrade({ side: 'buy', rmb: 5000, ts: Date.UTC(2026, 10, 2, 2, 0) }, p,
    { mid: 850, buy: 852.5, sell: 847.5 }, cfg,
    { plan: { maxTradesPerDay: 2, minIntervalHours: 4, maxPositionPct: 60 }, trades: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /仓位|position|敞口/);
});

test('benchmark tracks buy-and-hold gold return from first fill', async (t) => {
  const { svc, setClock } = harness(t, { prices: [4000, 4400] });
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 5000 });
  const st1 = svc.status();
  assert.ok(st1.benchmark != null, 'benchmark seeded on first fill');
  setClock(Date.UTC(2026, 10, 2, 3, 0));
  await svc.tickPrices();
  const st2 = svc.status();
  assert.ok(st2.benchmarkReturnPct > 0, `benchmark rose with gold: ${st2.benchmarkReturnPct}`);
});

test('circuit breaker pauses the engine at a hard loss', async (t) => {
  const { svc, setClock, db } = harness(t, { prices: [4090, 3200] });
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 5000 });
  setClock(Date.UTC(2026, 10, 2, 3, 0));
  await svc.tickPrices(); // huge drop -> total return past -15%
  const r = await svc.runCycle();
  assert.equal(r.circuitBreaker, true, JSON.stringify(r));
  assert.equal(svc.isPaused(), true, 'engine paused and persisted');
  assert.equal(db.getState('paused'), true, 'paused persisted');
});

test('low-confidence LLM decisions are held', async (t) => {
  const { svc } = harness(t, {
    llm: async () => JSON.stringify({ action: 'buy', amountRmb: 2000, reason: 'r', confidence: 0.1 }),
  });
  await svc.tickPrices();
  const r = await svc.runCycle();
  assert.equal(r.decision.action, 'hold');
  assert.match(r.decision.reason, /置信度|confidence/i);
});

test('daily loss limit stops trading for the rest of the day', async (t) => {
  const { svc, setClock } = harness(t, { prices: [4090, 3800] });
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 5000 });
  setClock(Date.UTC(2026, 10, 2, 3, 0));
  await svc.tickPrices(); // big intraday loss -> past dailyLossLimitPct
  const r = await svc.runCycle();
  assert.equal(r.dayLossHit, true, JSON.stringify(r));
});

test('reference strategy must beat the benchmark', () => {
  const cfg = { stableMinTrades: 5, stableMaxDrawdownPct: -5, stableMinReturnPct: 0 };
  const stats = { trades: 8, returnPct: 4, maxDrawdownPct: -3 };
  assert.equal(stabilityCheck(stats, cfg, 6), false, '4% strategy return must not beat 6% benchmark');
  assert.equal(stabilityCheck(stats, cfg, 2), true, '4% strategy beats 2% benchmark');
});
