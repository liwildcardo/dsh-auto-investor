import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.js';
import { resolveConfig } from '../lib/config.js';
import { createService } from '../lib/service.js';
import { registerRoutes } from '../lib/routes.js';

/**
 * Harness: register the real routes against a real service and invoke the
 * registered fetch handlers directly (the browser would POST to these same
 * handlers through the GUI session). This proves each dashboard operation's
 * server path end to end without needing GUI auth.
 */
function harness(t) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ai-routes-')), 'x.db'), { backend: 'json' });
  t.after(() => db.close());
  const cfg = resolveConfig({});
  const clock = Date.UTC(2026, 10, 2, 2, 0); // Mon 10:00 Shanghai, in window
  const fetchFn = async (url) => String(url).includes('gold-api')
    ? { ok: true, json: async () => ({ price: 4090 }) }
    : { ok: true, json: async () => ({ rates: { CNY: 7 } }), text: async () => '<rss></rss>' };
  const llm = async (prompt) => (prompt.includes('复盘引擎')
    ? JSON.stringify({ action: 'hold', reason: 'r', critique: '复盘结论' })
    : JSON.stringify({ action: 'hold', reason: 'r', confidence: 0.6 }));
  const svc = createService({ db, cfg, fetchFn, llm, now: () => clock });
  const routes = [];
  const ctx = { connection: { fetch: { register: (r) => { routes.push(r); return () => {}; } } } };
  const state = { lastRun: null };
  registerRoutes(ctx, svc, state);
  const call = async (path, method, body) => {
    const r = routes.find(x => x.path === path && x.methods.includes(method));
    assert.ok(r, `route ${method} ${path} must be registered`);
    const request = body === undefined
      ? undefined
      : { json: async () => { if (body === '__bad__') throw new Error('bad'); return body; } };
    const res = await r.fetch(request);
    return { status: res.status, body: await res.json() };
  };
  return { svc, db, state, call };
}

test('操作栏四个动作在路由层全部接通（run/reflect/pause/resume）', async (t) => {
  const { svc, db, state, call } = harness(t);

  // 立即分析
  const run = await call('/api/auto-investor/action', 'POST', { kind: 'run' });
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, true);
  assert.ok(run.body.result?.decision, 'run returns a decision payload');
  assert.ok(state.lastRun > 0, 'dashboard lastRun stamped');

  // 立即复盘
  const reflect = await call('/api/auto-investor/action', 'POST', { kind: 'reflect' });
  assert.equal(reflect.status, 200);
  assert.equal(reflect.body.ok, true);
  assert.equal(typeof reflect.body.result?.reflected, 'boolean');

  // 暂停
  const pause = await call('/api/auto-investor/action', 'POST', { kind: 'pause' });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.paused, true);
  assert.equal(svc.isPaused(), true, 'service paused');
  assert.equal(db.getState('paused'), true, 'pause persisted');

  // 恢复
  const resume = await call('/api/auto-investor/action', 'POST', { kind: 'resume' });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.paused, false);
  assert.equal(svc.isPaused(), false, 'service resumed');
  assert.equal(db.getState('paused'), false, 'resume persisted');
});

test('交易动作在 API 层已下线（用户不能直接下单）', async (t) => {
  const { call } = harness(t);
  const trade = await call('/api/auto-investor/action', 'POST', { kind: 'trade', op: { side: 'buy', rmb: 2000 } });
  assert.equal(trade.status, 400);
  assert.match(String(trade.body.reason), /unknown action kind: trade/);
});

test('非法请求体被拒绝且不影响引擎', async (t) => {
  const { call } = harness(t);
  const bad = await call('/api/auto-investor/action', 'POST', '__bad__');
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.reason), /invalid JSON body/);
});

test('四个读接口均可用（state/news/trades/strategies）', async (t) => {
  const { call } = harness(t);
  const cases = [
    ['/api/auto-investor/state', ['versions', 'ingest', 'portfolio']],
    ['/api/auto-investor/news', ['news']],
    ['/api/auto-investor/trades', ['trades']],
    ['/api/auto-investor/strategies', ['versions', 'current']],
  ];
  for (const [path, keys] of cases) {
    const res = await call(path, 'GET');
    assert.equal(res.status, 200, `${path} status`);
    for (const k of keys) assert.ok(k in res.body, `${path} missing ${k}`);
  }
});
