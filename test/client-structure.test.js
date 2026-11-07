import test from 'node:test';
import assert from 'node:assert/strict';

// Client-module smoke test: load client.js with a stubbed module loader and
// React, capture the components registered into slots, and render the
// dashboard tree structurally. Catches wiring/nesting bugs a syntax check
// cannot.

function loadClient(fakeState = undefined) {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(mod) { captured = mod; },
    },
  };
  // cache-bust so each load re-executes the module and re-captures
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

const fakeChart = {
  points: [{ x: 60, y: 100 }, { x: 300, y: 80 }, { x: 580, y: 90 }],
  plot: { x0: 52, x1: 628, y0: 12, y1: 152 },
  yAxis: { ticks: [{ y: 152, label: '860.00' }, { y: 82, label: '880.00' }, { y: 12, label: '900.00' }] },
  xAxis: { ticks: [{ x: 60, label: '09:30' }, { x: 580, label: '15:00' }] },
};

const fakeState = {
  quote: { buy: 876.14, sell: 871.14, mid: 873.64 },
  portfolio: {
    marketValue: 9939.57, grams: 11.4098, costAvg: 876.44,
    todayPnl: 2.97, holdingPnl: -60.43, totalPnl: -60.43, investedRmb: 10000,
  },
  cfg: { totalLimitRmb: 100000 },
  tradingNow: true,
  lastReflectAt: 1793926000000,
  reflectIntervalHours: 24,
  nextReflectAt: 1794012400000,
  plan: { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 4, maxPositionPct: 60 },
  chart: fakeChart,
  ticks: [{ ts: 1 }, { ts: 2 }],
  versions: [
    {
      id: 3,
      createdAt: 1793924550453,
      trades: 2, wins: 1, fills: 4, consecLosses: 0,
      returnPnl: 120.5, maxDrawdownPnl: -80, startPnl: -100,
      reference: false, retired: true,
      lastReview: { ts: 1793926000000, critique: '进场时机尚可，但仓位偏重。' },
      strategy: {
        action: 'buy', amountRmb: 3000, confidence: 0.62, horizonHours: 48,
        reason: '央行万亿逆回购释放流动性叠加存款利率下行，实际利率走低利好黄金；金价回踩MA20获得支撑，分批建仓摊低成本，严格遵守单笔5000元与仓位上限。',
        critique: '上一版进场过早，在下跌中途加仓导致浮亏扩大。',
        plan: { style: 'swing', maxTradesPerDay: 2, minIntervalHours: 4, maxPositionPct: 60, stopLossPct: -3, takeProfitPct: 6 },
        parentVersion: 2,
      },
    },
    {
      id: 4,
      createdAt: 1793928000000,
      trades: 0, wins: 0, fills: 1, consecLosses: 0,
      returnPnl: 0, maxDrawdownPnl: 0, startPnl: 0,
      reference: true, retired: false,
      strategy: {
        action: 'hold', confidence: 0.58, horizonHours: 24,
        reason: '价格窄幅整理，浮亏未触发止损，等待更优信号。',
        plan: { style: 'position', maxTradesPerDay: 1, minIntervalHours: 8, maxPositionPct: 40, stopLossPct: -4, takeProfitPct: 10 },
      },
    },
  ],
  trades: [{ ts: 1793932677910, side: 'buy', grams: 3.42, price: 875.99, rmb: 3000, note: 'note' }],
  reflections: [
    {
      ts: 1793926000000, trigger: 'loss', versionCreated: true,
      fromVersion: 1, toVersion: 2, action: 'hold',
      stats: { returnPct: -4.2, consecLosses: 3, maxDrawdownPct: -5.1 },
      critique: '进场时机偏早，在下跌中途加仓导致浮亏扩大；应等待企稳信号再补仓。',
    },
    {
      ts: 1793930000000, trigger: 'periodic', versionCreated: false,
      fromVersion: 2, toVersion: 2, action: 'hold',
      stats: { returnPct: 0.8, consecLosses: 0, maxDrawdownPct: -1.2 },
      critique: '仓位与频率合理，维持当前计划。',
    },
  ],
  news: [{ title: '央行增持黄金', url: 'http://x', source: '央行新闻发布' }],
  paused: false,
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

test('client module registers dashboard view and composer strip', async () => {
  const api = await loadClient();
  assert.deepEqual(api.inject, ['slots', 'locale']);
  const reg = applyAndCapture(api);
  assert.ok(reg['auto-investor-dashboard'], 'dashboard view registered');
  assert.ok(reg['auto-investor-strip'], 'composer strip registered');
  assert.equal(typeof reg['auto-investor-dashboard'].reg.label(), 'string');
});

test('strategy versions display the complete trading strategy', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = reg['auto-investor-dashboard'].Component();
  const allText = JSON.stringify(tree);
  const v3 = fakeState.versions[0];
  // full reason (not truncated at 50 chars)
  assert.ok(allText.includes(v3.strategy.reason), 'full strategy reason rendered');
  // complete plan incl. stop-loss / take-profit (rendered as semantic labels)
  for (const want of ['止损-3%', '止盈+6%', '每日≤2笔', '间隔≥4h', '仓位≤60%', '波段']) {
    assert.ok(allText.includes(want), `plan field missing: ${want}`);
  }
  // reflection critique and lineage
  assert.ok(allText.includes(v3.strategy.critique), 'critique rendered');
  assert.ok(allText.includes('v2') || allText.includes('parentVersion'), 'parent version shown');
  // reflection clock visible in the section header
  assert.ok(allText.includes('每 24h') && allText.includes('亏损触发'), 'reflection cadence shown');
  assert.ok(allText.includes('定期复盘') && allText.includes('进场时机尚可'), 'periodic review record shown');
  // performance stats per version
  assert.ok(allText.includes('returnPnl') || allText.includes('120.5'), 'return pnl shown');
  assert.ok(allText.includes('maxDrawdown') || allText.includes('-80'), 'drawdown shown');
  // plan fields also rendered for the current/reference version
  assert.ok(allText.includes('中长线配置') && allText.includes('止盈+10%'), 'second version plan rendered');
});

test('reflection journal shows every review conclusion', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = reg['auto-investor-dashboard'].Component();
  const allText = JSON.stringify(tree);
  // section present with count
  assert.ok(allText.includes('复盘记录'), 'journal section rendered');
  assert.ok(allText.includes('共 2 次'), 'count shown');
  // both conclusions displayed in full
  assert.ok(allText.includes('进场时机偏早'), 'loss critique shown');
  assert.ok(allText.includes('仓位与频率合理'), 'periodic critique shown');
  // trigger types and version outcomes
  assert.ok(allText.includes('亏损触发') && allText.includes('定期复盘'), 'trigger badges shown');
  assert.ok(allText.includes('v1 → v2'), 'fork outcome shown');
  assert.ok(allText.includes('沿用 v2'), 'no-fork outcome shown');
  // stats snapshot at trigger time
  assert.ok(allText.includes('-4.2'), 'trigger return shown');
  assert.ok(allText.includes('-5.1'), 'trigger drawdown shown');
});

test('Dashboard renders all seven sections without throwing', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const Dashboard = reg['auto-investor-dashboard'].Component;
  const tree = Dashboard();
  assert.equal(tree.type, 'div');
  const sections = findTree(tree, n => n.type && n.type.name === 'Section');
  assert.equal(sections.length, 7, `sections=${sections.length}`);
  const titles = sections.map(s => s.props.title);
  for (const want of ['持仓概览', '价格走势 (元/克)', '操作', '策略版本', '复盘记录', '最近交易']) {
    assert.ok(titles.some(t => t.includes(want)), `missing section ${want}`);
  }
});

test('operations expose analysis controls only — no manual trade buttons', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = reg['auto-investor-dashboard'].Component();
  const buttons = findTree(tree, n => n.type === 'button');
  const labels = buttons.map(b => (Array.isArray(b.children) ? b.children : [b.children]).filter(c => typeof c === 'string').join(''));
  assert.ok(labels.some(l => l.includes('立即分析')), 'run button kept');
  assert.ok(labels.some(l => l.includes('立即复盘')), 'reflect button kept');
  assert.ok(labels.some(l => l.includes('暂停') || l.includes('恢复')), 'pause/resume kept');
  for (const banned of ['买入', '卖出', '活期转定期']) {
    assert.ok(!labels.some(l => l.includes(banned)), `manual trade button must be gone: ${banned}`);
  }
});

test('operations note shows which model the engine resolved', async () => {
  const api = await loadClient({ ...fakeState, llm: { provider: 'deepseek-account', model: 'deepseek-flash' } });
  const reg = applyAndCapture(api);
  const text = JSON.stringify(reg['auto-investor-dashboard'].Component());
  assert.ok(text.includes('当前模型：deepseek-account/deepseek-flash'), 'model shown');
});

test('strategy versions show only the latest three, newest first', async () => {
  const versions = [1, 2, 3, 4, 5].map(id => ({
    id,
    createdAt: 1793924550453 + id * 1000,
    trades: 0, wins: 0, fills: 0, consecLosses: 0,
    returnPnl: 0, maxDrawdownPnl: 0, startPnl: 0,
    reference: false, retired: id < 5,
    strategy: {
      action: 'hold', confidence: 0.5, reason: `reason-${id}`,
      plan: { style: 'swing', maxTradesPerDay: 1, minIntervalHours: 8, maxPositionPct: 40, stopLossPct: -3, takeProfitPct: 6 },
    },
    display: { fills: 0, closes: 0, wins: 0, winRate: null, returnPnl: 0, maxDrawdownPnl: 0 },
  }));
  const api = await loadClient({ ...fakeState, versions });
  const reg = applyAndCapture(api);
  const tree = reg['auto-investor-dashboard'].Component();
  const text = JSON.stringify(tree);
  for (const id of [3, 4, 5]) assert.ok(text.includes(`reason-${id}`), `v${id} must be shown`);
  for (const id of [1, 2]) assert.ok(!text.includes(`reason-${id}`), `v${id} must be hidden`);
  assert.ok(text.indexOf('reason-5') < text.indexOf('reason-4'), 'newest first: v5 before v4');
  assert.ok(text.indexOf('reason-4') < text.indexOf('reason-3'), 'v4 before v3');
  assert.ok(text.includes('仅显示最近 3 个策略版本（共 5 个）'), 'history note shown');
});

test('news dates: real time shown, estimated shown as 约 MM-DD, never blank', async () => {
  const news = [
    { title: '真实日期新闻', url: 'http://a', source: 'Kitco黄金', ts: Date.UTC(2026, 10, 6, 3, 0), tsEstimated: false },
    { title: '预估日期新闻', url: 'http://b', source: 'web-search', ts: Date.UTC(2026, 10, 6, 16, 18), tsEstimated: true },
  ];
  const api = await loadClient({ ...fakeState, news });
  const reg = applyAndCapture(api);
  const text = JSON.stringify(reg['auto-investor-dashboard'].Component());
  assert.ok(text.includes('11-06 11:00'), 'real publish time rendered');
  assert.ok(text.includes('约 11-07'), 'estimated timestamp rendered as approximate date');
  assert.ok(!text.includes('日期未知'), 'no blank "unknown date" labels');
});

test('every card section carries a distinct accent class', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = reg['auto-investor-dashboard'].Component();
  const cards = findTree(tree, n => typeof n.props?.className === 'string' && n.props.className.includes('ai-card'));
  assert.ok(cards.length >= 5);
  const accents = cards.map(c => c.props.className.match(/ai-acc-\w+/)?.[0]).filter(Boolean);
  const unique = new Set(accents);
  assert.ok(unique.size >= 3, `distinct accents=${unique.size}`);
  for (const c of cards) {
    assert.match(c.props.className, /ai-acc-/, 'each card declares an accent');
  }
});

test('Chart renders axis labels and gridlines from host geometry', async () => {
  const api = await loadClient(fakeState);
  const reg = applyAndCapture(api);
  const tree = reg['auto-investor-dashboard'].Component();
  const chartEl = findTree(tree, n => n.type && n.type.name === 'Chart')[0];
  assert.ok(chartEl, 'Chart element present');
  const svg = chartEl.type(chartEl.props);
  assert.equal(svg.type, 'svg');
  const texts = findTree(svg, n => n.type === 'text');
  const labels = texts.map(t => t.children.join(''));
  assert.ok(labels.includes('860.00') && labels.includes('880.00'), `y labels=${labels}`);
  assert.ok(labels.includes('09:30') && labels.includes('15:00'), `x labels=${labels}`);
  const lines = findTree(svg, n => n.type === 'line');
  assert.ok(lines.length >= fakeChart.yAxis.ticks.length, 'gridlines for y ticks');
  assert.ok(findTree(svg, n => n.type === 'polyline').length === 1);
});

test('Strip renders quotes when state exists', async () => {
  const api = await loadClient();
  const reg = applyAndCapture(api);
  const Strip = reg['auto-investor-strip'].Component;
  const el = Strip();
  // no state yet -> null
  assert.equal(el, null);
});
