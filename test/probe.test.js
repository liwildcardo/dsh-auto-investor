import test from 'node:test';
import assert from 'node:assert/strict';
import { probePipelines, PROBES } from '../core/probe.js';
import { registerRoutes } from '../lib/routes.js';

/**
 * 按 URL 片段返回 fixture 的 mock fetchFn：探针框架只关心"可达+可解析"，
 * 因此 fixture 只需覆盖各源的最小可解析载荷（与 brief 一致）。
 */
const FIXTURES = [
  ['push2.eastmoney.com/api/qt/stock/get', '{"data":{"f43":26190,"f86":1764100000}}'],
  ['push2his.eastmoney.com/api/qt/stock/kline/get', '{"data":{"klines":["2026-11-20,450.1,452.0","2026-11-21,452.0,453.5"]}}'],
  ['api.gold-api.com/price/XAU', '{"price":4100.5}'],
  ['api.gold-api.com/price/XAG', '{"price":41.5}'],
  ['open.er-api.com', '{"rates":{"CNY":7.1}}'],
  ['qt.gtimg.cn', 'v_sh000001="1~上证指数~000001~3300~..."'],
  ['web.ifzq.gtimg.cn', '{"data":{"sh000001":{"qfqday":[["2026-11-20","3300","3310","3290","3305","1000"]]}}}'],
];

function fixtureFetch(extra = {}) {
  return async (url) => {
    const u = String(url);
    if (typeof extra.match === 'function' && extra.match(u)) throw extra.error;
    const hit = FIXTURES.find(([p]) => u.includes(p));
    if (!hit) throw new Error(`unexpected url: ${u}`);
    return { ok: true, status: 200, text: async () => hit[1] };
  };
}

test('probePipelines 全部可达', async () => {
  const r = await probePipelines(fixtureFetch());
  assert.equal(r.results.length, 9, 'nine probes registered');
  assert.equal(r.summary.failed, 0);
  assert.equal(r.summary.ok, 9);
  for (const item of r.results) {
    assert.equal(item.ok, true, `${item.id} should be ok: ${item.detail ?? ''}`);
    assert.ok(item.ms >= 0, `${item.id} ms recorded`);
    assert.ok(item.url.length > 0 && item.label.length > 0, `${item.id} has url+label`);
  }
  assert.equal(PROBES.length, 9, 'PROBES exported');
});

test('单源失败不污染其他源', async () => {
  const fetchFn = fixtureFetch({
    match: (u) => u.includes('secid=171.UI10Y'),
    error: new Error('web: timeout | direct: ECONNREFUSED'),
  });
  const r = await probePipelines(fetchFn);
  assert.equal(r.summary.failed, 1, 'exactly one probe fails');
  const bad = r.results.find((x) => x.id === 'em-ui10y');
  assert.equal(bad.ok, false);
  assert.match(String(bad.detail), /ECONNREFUSED/);
  const others = r.results.filter((x) => x.id !== 'em-ui10y');
  assert.equal(others.length, 8);
  for (const item of others) assert.equal(item.ok, true, `${item.id} unaffected`);
});

test('路由返回探测结果（无 probe 的 service 回空）', async () => {
  const makeRoutes = (service) => {
    const routes = [];
    const ctx = { connection: { fetch: { register: (r) => { routes.push(r); return () => {}; } } } };
    registerRoutes(ctx, service, { lastRun: null });
    return routes;
  };

  const withProbe = makeRoutes({
    probe: async () => ({ at: 1, results: [{ id: 'x', label: 'L', url: 'u', ok: true, ms: 1 }], summary: { ok: 1, failed: 0 } }),
  });
  const r1 = withProbe.find((x) => x.path === '/api/auto-investor/probe' && x.methods.includes('GET'));
  assert.ok(r1, 'GET probe route registered');
  const res1 = await r1.fetch();
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.ok(Array.isArray(body1.results), 'results array');
  assert.equal(body1.results[0].id, 'x');
  assert.equal(body1.summary.ok, 1);

  const withoutProbe = makeRoutes({});
  const r2 = withoutProbe.find((x) => x.path === '/api/auto-investor/probe' && x.methods.includes('GET'));
  assert.ok(r2, 'route registered even without service.probe');
  const body2 = await (await r2.fetch()).json();
  assert.deepEqual(body2.results, []);
  assert.deepEqual(body2.summary, { ok: 0, failed: 0 });
});
