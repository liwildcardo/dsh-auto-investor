import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';

function harness(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-refl-'));
  const db = openDb(join(dir, 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const cfg = resolveConfig({});
  let clock = opts.start ?? Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 SH
  const fetchFn = async (url) => String(url).includes('gold-api')
    ? { ok: true, json: async () => ({ price: 4090 }) }
    : { ok: true, json: async () => ({ rates: { CNY: 7 } }), text: async () => '<rss></rss>' };
  const llmCalls = [];
  const llm = opts.llm ?? (async (prompt) => {
    llmCalls.push(prompt);
    return JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 });
  });
  const svc = createService({ db, cfg, fetchFn, llm, now: () => clock });
  return { svc, db, cfg, llmCalls, setClock: (c) => { clock = c; } };
}

test('reflection triggers on exposure-relative loss, not the 100k ceiling', async (t) => {
  const { svc } = harness(t);
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 2000 });
  svc.debugForceLoss(70); // -3.5% of 2000 deployed, but only -0.07% of the 100k ceiling
  const r = await svc.reflectIfDue();
  assert.equal(r.reflected, true, `expected reflection: ${JSON.stringify(r)}`);
  assert.ok(r.stats.returnPct <= -3, `returnPct=${r.stats.returnPct} must be exposure-relative`);
});

test('periodic reflection runs every 24h even with no losses', async (t) => {
  const { svc, setClock, llmCalls } = harness(t);
  await svc.tickPrices();
  const r1 = await svc.reflectIfDue();
  assert.equal(r1.reflected, false, 'not due right after start');
  assert.equal(llmCalls.length, 0, 'no LLM call before due');

  setClock(Date.UTC(2026, 10, 3, 3, 0)); // +25h
  const r2 = await svc.reflectIfDue();
  assert.equal(r2.reflected, true, 'periodic review must run without losses');
  assert.equal(llmCalls.length, 1);
  assert.equal(r2.versionCreated, false, 'unchanged plan must not fork a version');
  assert.equal(svc.versions.length, 1, 'version history stays continuous');
  assert.ok(svc.versions[0].lastReview, 'review recorded on the version');

  const r3 = await svc.reflectIfDue();
  assert.equal(r3.reflected, false, 'clock resets after a review');
});

test('periodic reflection with a changed plan forks a new version', async (t) => {
  const { svc, setClock } = harness(t, {
    llm: async () => JSON.stringify({
      action: 'hold',
      reason: 'r',
      confidence: 0.6,
      plan: {
        style: 'position', maxTradesPerDay: 1, minIntervalHours: 8,
        maxPositionPct: 40, stopLossPct: -4, takeProfitPct: 10,
      },
    }),
  });
  await svc.tickPrices();
  setClock(Date.UTC(2026, 10, 3, 3, 0)); // +25h
  const r = await svc.reflectIfDue();
  assert.equal(r.reflected, true);
  assert.equal(r.versionCreated, true, 'material plan change must fork');
  assert.equal(svc.versions.length, 2);
  assert.equal(svc.versions[1].strategy.plan.style, 'position');
  assert.equal(svc.versions[0].retired, true);
});

test('status exposes the reflection clock', async (t) => {
  const { svc } = harness(t);
  await svc.tickPrices();
  const st = svc.status();
  assert.equal(typeof st.lastReflectAt, 'number');
  assert.equal(st.reflectIntervalHours, 24);
  assert.ok(st.nextReflectAt > st.lastReflectAt);
});

test('loss-triggered reflection still forks even when the plan is unchanged', async (t) => {
  const { svc } = harness(t);
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 2000 });
  svc.debugForceLoss(70);
  const r = await svc.reflectIfDue();
  assert.equal(r.reflected, true);
  assert.equal(r.versionCreated, true, 'loss always forks a fresh version');
  assert.equal(svc.versions.length, 2);
  assert.equal(svc.versions[0].retired, true);
  assert.ok(svc.versions[1].strategy.critique == null || typeof svc.versions[1].strategy.critique === 'string');
});

test('every reflection is journaled with its conclusion', async (t) => {
  const { svc, setClock } = harness(t, {
    llm: async () => JSON.stringify({
      action: 'hold', reason: 'r', confidence: 0.6,
      critique: '进场偏早，仓位过重；下次等待突破确认再加仓。',
    }),
  });
  await svc.tickPrices();

  // loss-triggered review -> journaled with the critique and version outcome
  svc.manualTrade({ side: 'buy', rmb: 2000 });
  svc.debugForceLoss(70);
  const r1 = await svc.reflectIfDue();
  assert.equal(r1.reflected, true);
  let st = svc.status();
  assert.equal(st.reflections.length, 1, 'loss review must be journaled');
  assert.equal(st.reflections[0].trigger, 'loss');
  assert.match(st.reflections[0].critique, /进场偏早/);
  assert.equal(st.reflections[0].versionCreated, true);
  assert.equal(st.reflections[0].fromVersion, 1);
  assert.equal(st.reflections[0].toVersion, 2);
  assert.equal(typeof st.reflections[0].stats.returnPct, 'number');
  assert.equal(typeof st.reflections[0].stats.maxDrawdownPct, 'number');

  // periodic review 25h later, plan unchanged -> journaled, no fork
  setClock(Date.UTC(2026, 10, 3, 3, 0));
  const r2 = await svc.reflectIfDue();
  assert.equal(r2.reflected, true);
  assert.equal(r2.versionCreated, false);
  st = svc.status();
  assert.equal(st.reflections.length, 2, 'periodic review must be journaled');
  assert.equal(st.reflections[1].trigger, 'periodic');
  assert.match(st.reflections[1].critique, /进场偏早/);
  assert.equal(st.reflections[1].fromVersion, st.reflections[1].toVersion, 'no fork keeps the same version');
  assert.equal(svc.versions.length, 2, 'only the loss forked a version');
});

test('reflection journal is bounded and ordered', async (t) => {
  const { svc, setClock } = harness(t);
  await svc.tickPrices();
  let clock = Date.UTC(2026, 10, 2, 2, 0);
  for (let i = 0; i < 105; i++) {
    clock += 25 * 3600_000;
    setClock(clock);
    const r = await svc.reflectIfDue();
    assert.equal(r.reflected, true, `iteration ${i} must reflect`);
  }
  const st = svc.status();
  assert.equal(st.reflections.length, 100, 'journal capped at 100');
  assert.equal(svc.versions.length, 1, 'periodic reviews never fork when plan is unchanged');
  for (let i = 1; i < st.reflections.length; i++) {
    assert.ok(st.reflections[i].ts > st.reflections[i - 1].ts, 'journal stays time-ordered');
  }
});

test('forced manual review runs without any trigger and journals its conclusion', async (t) => {
  const { svc } = harness(t, {
    llm: async () => JSON.stringify({
      action: 'hold', reason: 'r', confidence: 0.6,
      critique: '手动复盘：当前计划运行正常，维持不变。',
    }),
  });
  await svc.tickPrices();
  // not due: no loss, clock not elapsed
  const r0 = await svc.reflectIfDue();
  assert.equal(r0.reflected, false, 'gated when nothing is due');

  const r = await svc.reflectIfDue({ force: true });
  assert.equal(r.reflected, true, 'force bypasses the gate');
  assert.equal(r.versionCreated, false, 'unchanged plan keeps the version');
  const st = svc.status();
  assert.equal(st.reflections.length, 1);
  assert.equal(st.reflections[0].trigger, 'manual');
  assert.match(st.reflections[0].critique, /手动复盘/);
  assert.equal(svc.versions.length, 1);
});

test('a forced review still reports a loss trigger as loss', async (t) => {
  const { svc } = harness(t);
  await svc.tickPrices();
  svc.manualTrade({ side: 'buy', rmb: 2000 });
  svc.debugForceLoss(70);
  const r = await svc.reflectIfDue({ force: true });
  assert.equal(r.reflected, true);
  const st = svc.status();
  assert.equal(st.reflections[0].trigger, 'loss', 'loss is the more specific trigger');
});
