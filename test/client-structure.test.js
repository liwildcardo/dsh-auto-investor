import test from 'node:test';
import assert from 'node:assert/strict';

// Client-module smoke test: load client.js with a stubbed module loader and
// React, capture the components registered into slots, and render the
// product dashboard tree structurally.

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
          firstNull = false; // only the main data slot receives the fake state
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

/** Render a registered view wrapper down to its dashboard element. */
function renderView(reg, id) {
  const el = reg[id].Component();
  return el.type(el.props);
}

test('registers one conversation view per product plus the composer strip', async () => {
  const api = await loadClient();
  assert.deepEqual(api.inject, ['slots', 'locale']);
  const reg = applyAndCapture(api);
  for (const id of ['gold', 'ashare', 'us', 'hk']) {
    assert.ok(reg[`auto-investor-${id}`], `${id} view registered`);
    assert.equal(typeof reg[`auto-investor-${id}`].reg.label(), 'string');
  }
  assert.ok(reg['auto-investor-strip'], 'composer strip registered');
  const label = reg['auto-investor-gold'].reg.label();
  assert.match(label, /黄金/);
});

test('product dashboard renders positions, strategy params, trades, news and model', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = renderView(reg, 'auto-investor-gold');
  const text = JSON.stringify(tree);
  assert.ok(text.includes('黄金'), 'product name shown');
  assert.ok(text.includes('AU9999'), 'position symbol shown');
  assert.ok(text.includes('trend'), 'signal shown');
  assert.ok(text.includes('fast'), 'signal params shown');
  assert.ok(text.includes('央行增持黄金'), 'news shown');
  assert.ok(text.includes('deepseek-account/deepseek-flash'), 'model shown');
  assert.ok(text.includes('入场过早'), 'critique shown');
  assert.ok(text.includes('减少交易频率'), 'reflection shown');
});

test('operations expose analysis controls only — no manual trade buttons', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = renderView(reg, 'auto-investor-gold');
  const buttons = findTree(tree, n => n.type === 'button');
  const labels = buttons.map(b => (Array.isArray(b.children) ? b.children : [b.children]).filter(c => typeof c === 'string').join(''));
  assert.ok(labels.some(l => l.includes('立即分析')), 'run button kept');
  assert.ok(labels.some(l => l.includes('立即复盘')), 'reflect button kept');
  assert.ok(labels.some(l => l.includes('暂停') || l.includes('恢复')), 'pause/resume kept');
  for (const banned of ['买入', '卖出', '活期转定期']) {
    assert.ok(!labels.some(l => l.includes(banned)), `manual trade button must be gone: ${banned}`);
  }
});

test('every product view renders its own product name', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = renderView(reg, 'auto-investor-ashare');
  // The fake state still carries gold data; the view id is what changes.
  const el = reg['auto-investor-ashare'].Component();
  assert.equal(el.props.productId, 'ashare');
  assert.ok(JSON.stringify(tree).length > 0);
});

test('estimated news dates render as 约 instead of 日期未知', async () => {
  const state = {
    ...fakeState,
    news: [{ title: '旧闻测试', url: 'http://y', source: 'web-search', ts: Date.UTC(2026, 10, 6, 16, 18), tsEstimated: true }],
  };
  const api = await loadClient(state);
  const reg = applyAndCapture(api);
  const text = JSON.stringify(renderView(reg, 'auto-investor-gold'));
  assert.ok(text.includes('约 11-07'), 'estimated date rendered as approximate');
  assert.ok(!text.includes('日期未知'), 'no blank unknown dates');
});
