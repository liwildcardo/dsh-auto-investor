import test from 'node:test';
import assert from 'node:assert/strict';

// Client-module smoke test: load client.js with a stubbed module loader and
// React, capture the components registered into slots, and render the single
// auto-investor page (product switcher + selected dashboard).

function loadClient(fakeState = undefined) {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load(mod) { captured = mod; } } };
  return import(`../client.js?t=${Date.now()}-${Math.random()}`).then(() => {
    const makeEl = (type, props, ...children) => ({ type, props: props ?? {}, children });
    let firstNull = true;
    const React = {
      createElement: makeEl,
      useState: (init) => {
        let v = typeof init === 'function' ? init() : init;
        if (init === null && fakeState !== undefined && firstNull) {
          firstNull = false; // only the dashboard's data slot receives the fake state
          v = fakeState;
        }
        return [v, () => {}];
      },
      useEffect: () => {},
      Fragment: 'Fragment',
    };
    const requireStub = (name) => {
      assert.equal(name, 'react');
      return React;
    };
    return captured.factory(requireStub);
  });
}

const fakeState = {
  product: { id: 'gold', name: '黄金', currency: 'CNY', unit: 'gram' },
  quote: { price: 875.35, buy: 877.85, sell: 872.85 },
  quoteTs: 1,
  paused: false,
  tradingNow: true,
  snapshot: {
    currency: 'CNY',
    cash: 98800,
    positions: [{ symbol: 'AU9999', qty: 2.34, costAvg: 870, price: 875.35, value: 2048.32, pnl: 12.52, today: 3.2 }],
    positionsValue: 2048.32,
    totalValue: 100848.32,
    invested: 2035.8,
    realizedPnl: 0,
    holdingPnl: 12.52,
    todayPnl: 3.2,
    totalPnl: 12.52,
  },
  versions: [{
    id: 1,
    createdAt: 1,
    strategy: {
      signals: [{ id: 'trend', params: { fast: 5, slow: 20 }, weight: 1.2 }],
      risk: { stopLossPct: -3, takeProfitPct: 6, perTrade: 5000 },
    },
  }],
  currentVersion: {
    id: 1,
    createdAt: 1,
    critique: '入场过早，需等待趋势确认',
    strategy: {
      signals: [{ id: 'trend', params: { fast: 5, slow: 20 }, weight: 1.2 }],
      risk: { stopLossPct: -3, takeProfitPct: 6, perTrade: 5000 },
    },
  },
  trades: [{ ts: 1, side: 'buy', symbol: 'AU9999', price: 870, rmb: 2035.8 }],
  news: [{ title: '央行增持黄金', url: 'http://x', source: '央行新闻发布', ts: Date.now(), tsEstimated: false }],
  reflections: [{ ts: 1, trigger: 'manual', critique: '减少交易频率', versionCreated: true }],
  series: [{ ts: 1, price: 870 }, { ts: 2, price: 875 }],
  chartSymbol: 'AU9999',
  fx: null,
  llm: { provider: 'deepseek-account', model: 'deepseek-flash' },
  ingest: null,
};

function applyAndCapture(api) {
  const registered = {};
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    get: () => undefined,
    slots: {
      inject(key, cb) { cb(); return () => {}; },
      register(reg, Component) { registered[reg.id] = { reg, Component }; return () => {}; },
    },
  };
  api.apply(ctx);
  return registered;
}

function findTree(node, pred, out = []) {
  if (node == null || typeof node === 'string') return out;
  if (Array.isArray(node)) { for (const c of node) findTree(c, pred, out); return out; }
  if (pred(node)) out.push(node);
  findTree(node.children, pred, out);
  return out;
}

/** Render the single page down to the selected product dashboard element. */
function renderPage(reg) {
  const el = reg['auto-investor-dashboard'].Component();
  const dash = findTree(el, n => typeof n.type === 'function' && n.props?.productId)[0]
    ?? findTree(el, n => typeof n.type === 'function')[0];
  return dash.type(dash.props);
}

test('registers exactly one plugin page plus the composer strip', async () => {
  const api = await loadClient();
  assert.deepEqual(api.inject, ['slots', 'locale']);
  const reg = applyAndCapture(api);
  assert.ok(reg['auto-investor-dashboard'], 'single dashboard view registered');
  assert.ok(reg['auto-investor-strip'], 'composer strip registered');
  const viewIds = Object.keys(reg).filter(k => !k.endsWith('strip'));
  assert.equal(viewIds.length, 1, `only one conversation view (got ${viewIds.join(',')})`);
  assert.match(reg['auto-investor-dashboard'].reg.label(), /自动投资机/);
});

test('the page renders an in-page product switcher', async () => {
  const api = await loadClient(fakeState);
  const page = applyAndCapture(api)['auto-investor-dashboard'].Component();
  const text = JSON.stringify(page);
  for (const name of ['黄金', 'A股', '美股', '港股']) {
    assert.ok(text.includes(name), `switcher shows ${name}`);
  }
  const buttons = findTree(page, n => n.type === 'button');
  assert.ok(buttons.length >= 4, 'product buttons rendered');
});

test('the selected product dashboard renders data and controls', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = renderPage(reg);
  const text = JSON.stringify(tree);
  assert.ok(text.includes('自动投资机 · 黄金'), 'product name shown');
  assert.ok(text.includes('AU9999'), 'position shown');
  assert.ok(text.includes('trend'), 'signal shown');
  assert.ok(text.includes('央行增持黄金'), 'news shown');
  assert.ok(text.includes('deepseek-account/deepseek-flash'), 'model shown');
  assert.ok(text.includes('入场过早'), 'critique shown');
  const buttons = findTree(tree, n => n.type === 'button');
  const labels = buttons.map(b => (Array.isArray(b.children) ? b.children : [b.children]).filter(c => typeof c === 'string').join(''));
  assert.ok(labels.some(l => l.includes('立即分析')));
  assert.ok(labels.some(l => l.includes('立即复盘')));
  for (const banned of ['买入', '卖出', '活期转定期']) {
    assert.ok(!labels.some(l => l.includes(banned)), `no manual trade button: ${banned}`);
  }
});

test('only the latest reflection is rendered', async () => {
  const state = {
    ...fakeState,
    reflections: [
      { ts: 1, trigger: 'loss', critique: '旧复盘A', versionCreated: false },
      { ts: 2, trigger: 'manual', critique: '旧复盘B', versionCreated: true },
      { ts: 3, trigger: 'periodic', critique: '最新复盘C', versionCreated: true },
    ],
  };
  const api = await loadClient(state);
  const text = JSON.stringify(renderPage(applyAndCapture(api)));
  assert.ok(text.includes('最新复盘C'), 'latest review shown');
  assert.ok(!text.includes('旧复盘A'), 'older review hidden');
  assert.ok(!text.includes('旧复盘B'), 'older review hidden');
});

test('estimated news dates render as 约 instead of 日期未知', async () => {
  const state = {
    ...fakeState,
    news: [{ title: '旧闻测试', url: 'http://y', source: 'web-search', ts: Date.UTC(2026, 10, 6, 16, 18), tsEstimated: true }],
  };
  const api = await loadClient(state);
  const reg = applyAndCapture(api);
  const text = JSON.stringify(renderPage(reg));
  assert.ok(text.includes('约 11-07'), 'estimated date rendered as approximate');
  assert.ok(!text.includes('日期未知'), 'no blank unknown dates');
});
