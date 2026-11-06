import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';
import { collectStream } from '../lib/llm.js';
import { buildReflectPrompt } from '../lib/strategist.js';

function harness(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-rv-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const cfg = resolveConfig({});
  let clock = Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 SH
  const prices = opts.prices ?? [860];
  let idx = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('gold-api')) {
      const price = prices[Math.min(idx, prices.length - 1)];
      idx += 1;
      return { ok: true, json: async () => ({ price }) };
    }
    return { ok: true, json: async () => ({ rates: { CNY: 7 } }), text: async () => '<rss></rss>' };
  };
  const llm = opts.llm ?? (async () => JSON.stringify({ action: 'hold', reason: 'r' }));
  const svc = createService({ db, cfg, fetchFn, llm, now: () => clock });
  return { svc, db, cfg, setClock: (c) => { clock = c; } };
}

test('service todayPnl uses the day-open quote, not the last tick', async (t) => {
  const { svc, setClock } = harness(t, { prices: [4090, 4080, 4070] });
  await svc.tickPrices(); // day open
  svc.manualTrade({ side: 'buy', rmb: 2000 }); // establish a position
  setClock(Date.UTC(2026, 10, 2, 3, 0));
  await svc.tickPrices();
  setClock(Date.UTC(2026, 10, 2, 4, 0));
  await svc.tickPrices();
  const st = svc.status();
  assert.ok(st.dayOpenQuote, 'dayOpenQuote exposed');
  assert.ok(st.quoteTs, 'quoteTs exposed');
  const grams = st.portfolio.grams;
  assert.ok(grams > 0);
  // day P&L measured from the day-open quote, not the previous tick
  const expected = (st.quote.sell - st.dayOpenQuote.sell) * grams;
  assert.ok(Math.abs(st.portfolio.todayPnl - expected) < 0.02, `todayPnl=${st.portfolio.todayPnl} expected=${expected}`);
  // and it differs from tick-over-tick (the previous tick was not the day open)
  assert.ok(Math.abs(st.quote.sell - st.dayOpenQuote.sell) > 0.5);
});

test('service rejects unknown trade side', async (t) => {
  const { svc } = harness(t);
  await svc.tickPrices();
  const r = svc.manualTrade({ side: 'SELL', grams: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown|side|方向/i);
});

test('yield settlement credits at most once per quarter', async (t) => {
  const { svc } = harness(t);
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 2000 });
  const before = svc.status().portfolio.grams;
  const first = svc.settleYield(0.35);
  assert.ok(first > 0, 'first settlement credits grams');
  const second = svc.settleYield(0.35);
  assert.equal(second, 0, 'second settlement in the same quarter does nothing');
  const after = svc.status().portfolio.grams;
  assert.ok(after > before);
});

test('collectStream throws on a finish chunk with an error reason', async () => {
  const stream = (async function* () {
    yield { type: 'text-delta', text: 'hello' };
    yield { type: 'finish', reason: { kind: 'error', message: '401 unauthorized' } };
  })();
  await assert.rejects(() => collectStream(stream), /401|error/i);
  const ok = (async function* () {
    yield { type: 'text-delta', text: '{"a":1}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  assert.equal(await collectStream(ok), '{"a":1}');
});

test('reflect prompt includes the current plan and requires a new one', () => {
  const p = buildReflectPrompt(
    { id: 3, strategy: { plan: { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 4 } } },
    { trades: 2, returnPct: -4 },
    { summary: {}, news: [] },
    { perTradeLimitRmb: 5000 },
  );
  assert.match(p, /plan/);
  assert.match(p, /maxTradesPerDay/);
});

test('day-open backfills from the earliest tick of the current session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-rv-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  // pre-existing ticks from early today (before the plugin upgrade)
  db.insertTick({ ts: Date.UTC(2026, 10, 2, 0, 22), xauUsd: 4090, usdCny: 7, mid: 920.1, buy: 922.6, sell: 917.6 });
  db.insertTick({ ts: Date.UTC(2026, 10, 2, 1, 0), xauUsd: 4085, usdCny: 7, mid: 919.0, buy: 921.5, sell: 916.5 });
  const cfg = resolveConfig({});
  const fetchFn = async (url) => String(url).includes('gold-api')
    ? { ok: true, json: async () => ({ price: 4080 }) }
    : { ok: true, json: async () => ({ rates: { CNY: 7 } }), text: async () => '<rss></rss>' };
  const svc = createService({ db, cfg, fetchFn, llm: async () => '{}', now: () => Date.UTC(2026, 10, 2, 2, 0) });
  const st = svc.status();
  assert.ok(st.dayOpenQuote, 'dayOpenQuote present');
  assert.ok(Math.abs(st.dayOpenQuote.sell - 917.6) < 0.001, `backfilled dayOpen=${st.dayOpenQuote.sell}`);
});

test('stale quote blocks execution through the service', async (t) => {
  const { svc, setClock } = harness(t);
  await svc.tickPrices();
  setClock(Date.UTC(2026, 10, 2, 2, 10)); // 10 minutes later, no new tick
  const r = svc.manualTrade({ side: 'buy', rmb: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /行情|quote|陈旧|stale/i);
});
