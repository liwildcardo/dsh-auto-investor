import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

function makeService(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-svc-'));
  const db = openDb(join(join(dir, 'x.db')), { backend: 'json' });
  t.after(() => db.close());
  const cfg = resolveConfig({ holidays: ['2026-11-03'] });
  const calls = { fetch: [], llm: [] };
  const fetchFn = async (url) => {
    calls.fetch.push(url);
    if (String(url).includes('gold-api')) {
      return { ok: true, json: async () => ({ price: 4090.0, currency: 'USD' }) };
    }
    return { ok: true, json: async () => ({ rates: { CNY: 6.685421 } }), text: async () => '<rss></rss>' };
  };
  const llm = overrides.llm ?? (async (prompt) => {
    calls.llm.push(prompt);
    return JSON.stringify({ action: 'hold', reason: 'test', confidence: 0.5, horizonHours: 6 });
  });
  const svc = createService({ db, cfg, fetchFn, llm, now: () => Date.UTC(2026, 10, 2, 2, 0) }); // Mon 10:00 Shanghai
  return { svc, db, cfg, calls };
}

test('tickPrices stores a quote and keeps history', async (t) => {
  const { svc, db } = makeService(t);
  const q = await svc.tickPrices();
  assert.ok(q.buy > q.sell);
  assert.ok(Math.abs(q.buy - q.sell - 5) < 0.02);
  assert.equal(db.latestTicks(10).length, 1);
});

test('runCycle executes hold without trading', async (t) => {
  const { svc, calls } = makeService(t);
  const result = await svc.runCycle();
  assert.equal(result.decision.action, 'hold');
  assert.equal(result.trades.length, 0);
  assert.equal(result.rejection, null, 'hold is a valid decision, not a rejection');
  assert.equal(calls.llm.length, 1);
});

test('runCycle with buy-LLM performs a capped trade', async (t) => {
  const { svc } = makeService(t, {
    llm: async () => JSON.stringify({ action: 'buy', amountRmb: 2000, reason: 'r', confidence: 0.7, horizonHours: 24 }),
  });
  const result = await svc.runCycle();
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].side, 'buy');
  assert.ok(result.trades[0].rmb <= 5000);
  const st = svc.status();
  assert.ok(st.portfolio.grams > 0);
});

test('runCycle rejects out-of-limit LLM amounts but still records decision', async (t) => {
  const { svc } = makeService(t, {
    llm: async () => JSON.stringify({ action: 'buy', amountRmb: 9000, reason: 'r', confidence: 0.7, horizonHours: 24 }),
  });
  const result = await svc.runCycle();
  assert.equal(result.trades.length, 0);
  assert.match(result.rejection, /5000|单笔/);
});

test('manualTrade enforces rules and books position', async (t) => {
  const { svc } = makeService(t);
  await svc.tickPrices(); // index.js ticks at startup; mirror that here
  const ok = svc.manualTrade({ side: 'buy', rmb: 2000 });
  assert.equal(ok.ok, true);
  const st = svc.status();
  assert.ok(st.portfolio.grams > 0);
  const bad = svc.manualTrade({ side: 'buy', rmb: 9000 });
  assert.equal(bad.ok, false);
});

test('manualTrade rejects when the day quota is consumed', async (t) => {
  const { svc, db } = makeService(t);
  await svc.tickPrices();
  const nowTs = Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 Shanghai (service clock)
  // two market fills in the same trading session, both outside the 4h interval
  db.insertTrade({ ts: nowTs - 5 * 3600_000, side: 'buy', grams: 1, price: 850, rmb: 850, note: '' });
  db.insertTrade({ ts: nowTs - 7 * 3600_000, side: 'buy', grams: 1, price: 850, rmb: 850, note: '' });
  const r = svc.manualTrade({ side: 'buy', rmb: 1200 });
  assert.equal(r.ok, false, 'must not report ok when the frequency gate rejects');
  assert.match(r.reason, /频率|每日|interval/i);
  // and nothing was booked
  const st = svc.status();
  assert.equal(st.portfolio.grams, 0);
});

test('loss streak triggers reflection and creates a new version', async (t) => {
  let llmCalls = 0;
  const { svc } = makeService(t, {
    llm: async (prompt) => {
      llmCalls++;
      if (prompt.includes('复盘')) {
        return JSON.stringify({ critique: '进场过早', action: 'hold', reason: '改进', confidence: 0.6, horizonHours: 12 });
      }
      return JSON.stringify({ action: 'buy', amountRmb: 1200, reason: 'entry', confidence: 0.7, horizonHours: 24 });
    },
  });
  // run cycles; force losses by making prices fall hard between cycles
  for (let i = 0; i < 4; i++) {
    await svc.runCycle();
    // simulate adverse marks: lower the last tick's sell price to book losses on outcome review
    svc.debugForceLoss(500);
    await svc.reflectIfDue();
  }
  const st = svc.status();
  assert.ok(st.versions.length >= 2, `versions=${st.versions.length}`);
  assert.ok(st.versions.some(v => v.strategy?.critique), 'reflection critique recorded');
});

test('status exposes prices, portfolio, versions, news', async (t) => {
  const { svc } = makeService(t);
  await svc.runCycle();
  const st = svc.status();
  assert.ok(st.quote.buy > 0);
  assert.ok(st.portfolio);
  assert.ok(Array.isArray(st.versions));
  assert.ok(typeof st.tradingNow === 'boolean');
});
