import test from 'node:test';
import assert from 'node:assert/strict';

// Client-module smoke test: load client.js with a stubbed module loader and
// React, capture the components registered into slots, and render the single
// auto-investor page (product switcher + selected dashboard).

function loadClient(fakeState = undefined) {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load(mod) { captured = mod; } } };
  return import(`../client.js?t=${Date.now()}-${Math.random()}`).then(() => {
    // Mimic real React: children live on props.children (elements never carry
    // a top-level children field). findTree reads the mirrored top-level copy.
    const makeEl = (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children },
      children,
    });
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
  product: { id: 'gold', name: '黄金', currency: 'CNY', unit: 'gram', kind: 'single' },
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

/** A stock product state with an editable watchlist and named trades. */
const fakeStockState = {
  ...fakeState,
  product: { id: 'hk', name: '港股', currency: 'HKD', unit: 'share', kind: 'multi' },
  snapshot: {
    ...fakeState.snapshot,
    currency: 'HKD',
    positions: [{ symbol: 'hk09988', qty: 100, costAvg: 105, price: 108, value: 10800, pnl: 300, today: 120 }],
    positionsValue: 10800,
  },
  watchlist: [
    { symbol: 'hk00700', name: '腾讯控股', lot: 100 },
    { symbol: 'hk09988', name: '阿里巴巴', lot: 100 },
  ],
  chartSymbol: 'hk00700',
  trades: [{ ts: 1, side: 'buy', symbol: 'hk09988', name: '阿里巴巴', price: 105, rmb: 10500 }],
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

test('macro factor summary renders with values and data dates', async () => {
  const state = {
    ...fakeState,
    factors: {
      realYield: { value: 2.05, delta5d: -0.08, asOf: '2026-11-06', stale: false },
      usdIndex: { value: 99.12, delta5d: -0.4, asOf: '2026-11-09', stale: false },
    },
  };
  const api = await loadClient(state);
  const text = JSON.stringify(renderPage(applyAndCapture(api)));
  assert.ok(text.includes('宏观因子：'), 'factor summary row rendered');
  assert.ok(text.includes('实际收益率 2.05%'), 'real yield value');
  assert.ok(text.includes('-8bp'), '5-day change in bp');
  assert.ok(text.includes('美元指数 99.12'), 'usd index value');
  assert.ok(!text.includes('【过期】'), 'fresh data not flagged');
});

test('stale factors are flagged in the summary', async () => {
  const state = {
    ...fakeState,
    factors: {
      realYield: { value: 2.05, delta5d: -0.08, asOf: '2026-10-01', stale: true },
      usdIndex: null,
      inflationExp: null,
    },
  };
  const api = await loadClient(state);
  const text = JSON.stringify(renderPage(applyAndCapture(api)));
  assert.ok(text.includes('【过期】'), 'stale marker shown');
  assert.ok(text.includes('美元指数 数据不可用'), 'missing factor stated');
});

test('最新资讯 card lists news newest-first (dated before estimated)', async () => {
  const now = Date.now();
  const state = {
    ...fakeState,
    news: [
      { ts: now - 48 * 3600_000, title: '旧闻高分', score: 5, source: 'a', tsEstimated: false },
      { ts: now - 1 * 3600_000, title: '今天新闻', score: 2, source: 'b', tsEstimated: false },
      { ts: now, title: '估时新闻', score: 3, source: 'c', tsEstimated: true },
    ],
  };
  const api = await loadClient(state);
  const text = JSON.stringify(renderPage(applyAndCapture(api)));
  const iNew = text.indexOf('今天新闻');
  const iOld = text.indexOf('旧闻高分');
  const iEst = text.indexOf('估时新闻');
  assert.ok(iNew >= 0 && iOld >= 0 && iEst >= 0, 'all three rendered');
  assert.ok(iNew < iOld, `newer dated item first (new=${iNew}, old=${iOld})`);
  assert.ok(iOld < iEst, `estimated-ts item last (est=${iEst})`);
});

test('运行健康 line renders candidate rate, rejections and bars', async () => {
  const state = {
    ...fakeState,
    health: {
      cycles: 50,
      candidateRate: 0,
      rejections: { '标的不在候选或持仓中': 42, '非交易时段': 8 },
      signalCoverage: 0.45,
      bars: [{ symbol: 'usGOOGL', bars: 13 }],
      barsRequired: 52,
      llmErrorRate: 0,
    },
  };
  const api = await loadClient(state);
  const text = JSON.stringify(renderPage(applyAndCapture(api)));
  assert.ok(text.includes('运行健康'), 'health line rendered');
  assert.ok(text.includes('候选率 0%'), 'candidate rate shown');
  assert.ok(text.includes('标的不在候选或持仓中×42'), 'rejection breakdown shown');
  assert.ok(text.includes('信号覆盖 45%'), 'coverage shown');
  assert.ok(text.includes('bars 13/52'), 'bars vs requirement shown');
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

test('table headers align with their data columns (numeric right, rest left)', async () => {
  const api = await loadClient(fakeState);
  const tree = renderPage(applyAndCapture(api));
  // Prove the test double matches real React: rows keep children on props.
  const rows0 = findTree(tree, n => n.type === 'tr' && Array.isArray(n.props?.children) && n.props.children.length === 6);
  assert.ok(rows0.length > 0, 'row elements expose props.children (real React shape)');
  const ths = findTree(tree, n => n.type === 'th');
  const byLabel = {};
  for (const th of ths) {
    const kids = Array.isArray(th.props?.children) ? th.props.children : [th.props?.children];
    const label = kids.filter(c => typeof c === 'string').join('');
    byLabel[label] = th.props.className ?? null;
  }
  // Positions: 标的/名称 left, 数量/成本/现价/盈亏 right.
  assert.equal(byLabel['标的'], null, 'code column header left-aligned');
  assert.equal(byLabel['名称'], null, 'name column header left-aligned');
  assert.equal(byLabel['数量'], 'num', 'qty header right-aligned with its values');
  assert.equal(byLabel['成本'], 'num', 'cost header right-aligned');
  assert.equal(byLabel['现价'], 'num', 'price header right-aligned');
  assert.equal(byLabel['盈亏'], 'num', 'pnl header right-aligned');
  // Trades: 时间/方向/标的/名称 left, 价格/金额 right.
  assert.equal(byLabel['时间'], null, 'time header left-aligned');
  assert.equal(byLabel['方向'], null, 'side header left-aligned');
  assert.equal(byLabel['价格'], 'num', 'trade price header right-aligned');
  assert.equal(byLabel['金额'], 'num', 'trade amount header right-aligned');
  assert.equal(ths.filter(th => th.props.className === 'num').length, 6, '4 position + 2 trade numeric columns');
});

test('gold (single) shows no watchlist card or chart switcher', async () => {
  const api = await loadClient(fakeState);
  const text = JSON.stringify(renderPage(applyAndCapture(api)));
  assert.ok(!text.includes('自选池'), 'no watchlist card for gold');
  assert.ok(!text.includes('恢复默认池'), 'no pool actions for gold');
});

test('stock product renders watchlist editor, chart switcher and name columns', async () => {
  const api = await loadClient(fakeStockState);
  const tree = renderPage(applyAndCapture(api));
  const text = JSON.stringify(tree);

  // Watchlist editor: search box, pool chips with remove, reset, counter.
  assert.ok(text.includes('自选池'), 'watchlist card shown');
  assert.ok(text.includes('2/10'), 'counter shown');
  assert.ok(text.includes('腾讯控股 hk00700'), 'pool chip with name');
  assert.ok(text.includes('阿里巴巴 hk09988'), 'second pool chip');
  assert.ok(text.includes('恢复默认池'), 'reset action');
  const inputs = findTree(tree, n => n.type === 'input');
  assert.ok(inputs.length >= 1, 'search input rendered');
  // Alignment contract: the search-row button shares the input's 34px box and
  // drops the generic button margin (a bottom margin skewed it in the flex row).
  const styleNode = findTree(tree, n => n.type === 'style')[0];
  const styleText = (styleNode?.children ?? []).join('');
  assert.ok(styleText.includes('.ai-wl-search .ai-btn { margin: 0; height: 34px'), 'search-row button aligned to input');
  assert.ok(styleText.includes('.ai-input { flex: 1; min-width: 180px; height: 34px'), 'input fixed height');

  // Chart switcher pills.
  const buttons = findTree(tree, n => n.type === 'button');
  const labels = buttons.map(b => (Array.isArray(b.children) ? b.children : [b.children]).filter(c => typeof c === 'string').join(''));
  assert.ok(labels.includes('腾讯控股'), 'chart switcher has first symbol');
  assert.ok(labels.includes('阿里巴巴'), 'chart switcher has second symbol');

  // Name columns in positions and trades tables.
  assert.ok(text.includes('名称'), 'name column header present');
  assert.ok(text.includes('阿里巴巴'), 'trade name shown');
});
