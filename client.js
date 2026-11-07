/**
 * 自动投资机 (Auto Investor) — Client half.
 * Dashboard view (conversation.view) + live price strip (composer dock).
 * Data: GET /api/auto-investor/state, actions: POST /api/auto-investor/action.
 * Styling: --dsw-alias-* theme tokens only; each section carries a distinct
 * accent token and strong borders for clear module boundaries.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-investor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const fmt = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '--');
    const pnlClass = (v) => (v > 0 ? 'ai-up' : v < 0 ? 'ai-down' : 'ai-flat');
    // Decode HTML entities for rows stored before ingest-side decoding existed.
    const plain = (s) => String(s ?? '')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    // Publish stamp in Asia/Shanghai (fixed UTC+8). Undated sources keep an
    // approximate date ("约 MM-DD" = first-seen time) instead of hiding it;
    // date-only sources omit the clock.
    const newsWhen = (n) => {
      if (!n?.ts) return '';
      const d = new Date(n.ts + 8 * 3600_000);
      const p = (x) => String(x).padStart(2, '0');
      const date = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      if (n.tsEstimated) return `约 ${date}`;
      // Date-only sources parse to UTC or Shanghai midnight → omit the clock.
      if (n.ts % 86400_000 === 0 || (n.ts + 8 * 3600_000) % 86400_000 === 0) return date;
      return `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    };

    const CSS = `
      .ai-wrap { padding: 20px; color: var(--dsw-alias-label-primary); font-size: 13px;
        display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
      .ai-h { font-size: 17px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 8px; }
      .ai-h .ai-live { width: 8px; height: 8px; border-radius: 50%;
        background: var(--dsw-alias-state-success-primary); }

      /* Cards: strong border + colored accent bar + colored title */
      .ai-card { background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
        overflow: hidden; }
      .ai-card > .ai-sec { display: flex; align-items: center; gap: 8px;
        padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        font-size: 13px; font-weight: 600; }
      .ai-card > .ai-sec .ai-bar { width: 4px; height: 16px; border-radius: 2px; }
      .ai-card > .ai-body { padding: 14px 16px; }

      /* Section accents */
      .ai-acc-brand  .ai-sec { color: var(--dsw-alias-brand-primary); }
      .ai-acc-brand  .ai-bar  { background: var(--dsw-alias-brand-primary); }
      .ai-acc-green  .ai-sec { color: var(--dsw-alias-state-success-primary); }
      .ai-acc-green  .ai-bar  { background: var(--dsw-alias-state-success-primary); }
      .ai-acc-amber  .ai-sec { color: var(--dsw-alias-state-warn-primary); }
      .ai-acc-amber  .ai-bar  { background: var(--dsw-alias-state-warn-primary); }
      .ai-acc-red    .ai-sec { color: var(--dsw-alias-state-error-primary); }
      .ai-acc-red    .ai-bar  { background: var(--dsw-alias-state-error-primary); }
      .ai-acc-grey   .ai-sec { color: var(--dsw-alias-label-secondary); }
      .ai-acc-grey   .ai-bar  { background: var(--dsw-alias-state-idle-primary); }

      .ai-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .ai-metric { flex: 1 1 128px; min-width: 116px; padding: 10px 12px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px; }
      .ai-metric .k { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-bottom: 3px; }
      .ai-metric .v { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ai-up { color: var(--dsw-alias-state-success-primary); }
      .ai-down { color: var(--dsw-alias-state-error-primary); }
      .ai-flat { color: var(--dsw-alias-label-secondary); }

      .ai-chart { width: 100%; height: 190px; display: block; }
      .ai-chart .grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
      .ai-chart .axis-label { fill: var(--dsw-alias-label-secondary); font-size: 11px;
        font-variant-numeric: tabular-nums; }
      .ai-chart .line { stroke: var(--dsw-alias-state-success-primary); stroke-width: 2.5;
        fill: none; stroke-linejoin: round; stroke-linecap: round; }
      .ai-chart .last-dot { fill: var(--dsw-alias-state-success-primary); }

      .ai-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .ai-table th { text-align: left; color: var(--dsw-alias-label-secondary); font-weight: 600;
        padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        text-transform: none; }
      .ai-table td { padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        font-variant-numeric: tabular-nums; vertical-align: top; }
      .ai-table tr:last-child td { border-bottom: none; }

      .ai-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary); border-radius: 9px; padding: 8px 16px; cursor: pointer;
        font-size: 12px; font-weight: 600; margin: 0 8px 8px 0; }
      .ai-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .ai-btn:disabled { opacity: 0.5; cursor: default; }
      .ai-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }

      .ai-badge { display: inline-block; padding: 1px 9px; border-radius: 99px; font-size: 11px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
      .ai-badge.ref { border-color: var(--dsw-alias-state-warn-primary);
        color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
      .ai-badge.plan { border-color: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-brand-primary); }

      .ai-news li { margin: 6px 0; line-height: 1.5; }
      .ai-news a { color: var(--dsw-alias-label-primary); text-decoration: none; font-weight: 500; }
      .ai-news a:hover { color: var(--dsw-alias-brand-primary); }
      .ai-src { color: var(--dsw-alias-label-secondary); font-size: 11px; }

      .ai-note { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 6px; }
      .ai-reason { color: var(--dsw-alias-label-secondary); line-height: 1.5; }

      /* Strategy version cards: full strategy display */
      .ai-strat { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        padding: 12px 14px; margin-bottom: 12px; background: var(--dsw-alias-bg-layer-2); }
      .ai-strat:last-child { margin-bottom: 0; }
      .ai-strat-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .ai-strat-id { font-weight: 700; font-size: 15px; }
      .ai-strat-grid { display: flex; gap: 14px; flex-wrap: wrap; margin: 6px 0; }
      .ai-strat-cell { display: flex; gap: 6px; align-items: baseline; }
      .ai-strat-cell .k { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
      .ai-strat-cell .v { font-weight: 600; font-variant-numeric: tabular-nums; }
      .ai-strat-text { color: var(--dsw-alias-label-primary); line-height: 1.6; font-size: 12.5px; }
      .ai-plan { display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
        padding: 8px 10px; margin: 8px 0; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        font-size: 12px; font-variant-numeric: tabular-nums; }
      .ai-plan .k { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; }

      .ai-strip { display: flex; gap: 14px; align-items: center; padding: 5px 14px;
        color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
      .ai-strip b { color: var(--dsw-alias-label-primary); font-weight: 600; }

      .ai-tabs { display: flex; gap: 8px; padding: 12px 20px 0; flex-wrap: wrap; }
      .ai-tab { padding: 6px 14px; border-radius: 999px; cursor: pointer;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
        border: 1px solid var(--dsw-alias-border-l1); font-size: 13px; }
      .ai-tab.active { background: var(--dsw-alias-accent-brand, #b08d3f); color: #fff;
        border-color: transparent; font-weight: 600; }
    `;

    function Metric({ label, value, cls }) {
      return h('div', { className: 'ai-metric' },
        h('div', { className: 'k' }, label),
        h('div', { className: `v ${cls ?? ''}` }, value));
    }

    function Section({ accent, title, right }) {
      return h('div', { className: 'ai-sec' },
        h('span', { className: 'ai-bar' }),
        h('span', null, title),
        right ? h('span', { style: { marginLeft: 'auto' } }, right) : null);
    }

    /* Price chart with Y price axis and X time axis (geometry from host). */
    function Chart({ chart }) {
      if (!chart || !chart.points || chart.points.length < 2) {
        return h('div', { className: 'ai-flat' }, '暂无走势数据');
      }
      const W = 640;
      const H = 180;
      const path = chart.points.map(p => `${p.x},${p.y}`).join(' ');
      return h('svg', { className: 'ai-chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' },
        // horizontal gridlines + price labels (Y axis)
        chart.yAxis.ticks.map((t, i) => h('g', { key: `y${i}` },
          h('line', { className: 'grid', x1: chart.plot.x0, x2: chart.plot.x1, y1: t.y, y2: t.y }),
          h('text', {
            className: 'axis-label', x: chart.plot.x0 - 8, y: t.y + 4,
            textAnchor: 'end',
          }, t.label))),
        // time labels (X axis)
        chart.xAxis.ticks.map((t, i) => h('text', {
          key: `x${i}`, className: 'axis-label', x: t.x, y: H - 6, textAnchor: 'middle',
        }, t.label)),
        // axis frame
        h('line', {
          className: 'grid', x1: chart.plot.x0, x2: chart.plot.x0, y1: chart.plot.y0, y2: chart.plot.y1,
        }),
        h('line', {
          className: 'grid', x1: chart.plot.x0, x2: chart.plot.x1, y1: chart.plot.y1, y2: chart.plot.y1,
        }),
        h('polyline', { className: 'line', points: path }),
        h('circle', {
          className: 'last-dot',
          cx: chart.points[chart.points.length - 1].x,
          cy: chart.points[chart.points.length - 1].y, r: 4,
        }));
    }

    async function fetchProductState(productId) {
      const res = await fetch(`/api/auto-investor/state?product=${encodeURIComponent(productId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`state http ${res.status}`);
      return res.json();
    }

    function Sparkline({ series, currency }) {
      const pts = (series ?? []).filter(p => Number.isFinite(p.price));
      if (pts.length < 2) return h('div', { className: 'ai-flat' }, '暂无行情数据');
      const w = 600;
      const hgt = 140;
      const pad = 10;
      const ys = pts.map(p => p.price);
      const min = Math.min(...ys);
      const max = Math.max(...ys);
      const span = max - min || 1;
      const d = pts.map((p, i) => {
        const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
        const y = pad + (1 - (p.price - min) / span) * (hgt - pad * 2);
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return h('svg', { viewBox: `0 0 ${w} ${hgt}`, style: { width: '100%', height: 'auto', color: 'var(--dsw-alias-accent-brand, #b08d3f)' } },
        h('path', { d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('text', { x: pad, y: 14, className: 'ai-src' }, `${currency} ${max.toFixed(2)}`),
        h('text', { x: pad, y: hgt - 4, className: 'ai-src' }, `${min.toFixed(2)}`));
    }

    function ProductDashboard({ productId }) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const s = await fetchProductState(productId);
            if (alive) { setState(s); setError(null); }
          } catch (e) {
            if (alive) setError(String(e?.message ?? e));
          }
        };
        load();
        const timer = setInterval(load, 10_000);
        return () => { alive = false; clearInterval(timer); };
      }, [productId]);

      const act = async (kind) => {
        setBusy(true);
        setNotice(null);
        try {
          const res = await fetch('/api/auto-investor/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind, product: productId }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || body.ok === false) throw new Error(body.reason ?? `http ${res.status}`);
          const r = body.result ?? {};
          setNotice(kind === 'run'
            ? `分析完成：${r.decision?.action ?? '-'}${r.rejection ? `（${r.rejection}）` : ''}`
            : kind === 'reflect' ? `复盘完成${r.versionCreated ? '，已生成新版本' : ''}` : '已切换循环状态');
          setState(await fetchProductState(productId));
        } catch (e) {
          setNotice(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      if (error) {
        const disabled = /unknown product|未启用/.test(error);
        return h('div', { className: 'ai-wrap' }, h('style', null, CSS),
          h('div', { className: 'ai-flat' }, disabled
            ? '该产品未启用（可在插件配置 products 中启用）'
            : `加载失败：${error}`));
      }
      if (!state) {
        return h('div', { className: 'ai-wrap' }, h('style', null, CSS),
          h('div', { className: 'ai-flat' }, '加载中…'));
      }

      const p = state.product ?? {};
      const snap = state.snapshot ?? { positions: [] };
      const positions = snap.positions ?? [];
      const cur = state.currentVersion ?? {};
      const strat = cur.strategy ?? {};
      const fmtQty = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : '--');

      const table = (head, rows) => h('table', { className: 'ai-table' },
        h('thead', null, h('tr', null, head.map(x => h('th', { key: x }, x)))),
        h('tbody', null, rows));

      const card = (accent, title, right, children) => h('div', { className: `ai-card ai-acc-${accent}` },
        h(Section, { accent, title, right }),
        h('div', { className: 'ai-body' }, ...children));

      const positionRows = positions.map(pos => h('tr', { key: pos.symbol },
        h('td', null, pos.symbol),
        h('td', null, fmtQty(pos.qty)),
        h('td', null, fmt(pos.costAvg)),
        h('td', null, fmt(pos.price)),
        h('td', { className: pnlClass(pos.pnl) }, fmt(pos.pnl))));

      const metrics = h('div', { className: 'ai-metrics' },
        h('div', null, '现金 ', h('b', null, fmt(snap.cash))),
        h('div', null, '持仓市值 ', h('b', null, fmt(snap.positionsValue))),
        h('div', null, '持仓盈亏 ', h('b', { className: pnlClass(snap.holdingPnl) }, fmt(snap.holdingPnl))),
        h('div', null, '今日收益 ', h('b', { className: pnlClass(snap.todayPnl) }, fmt(snap.todayPnl))),
        h('div', null, '累计收益 ', h('b', { className: pnlClass(snap.totalPnl) }, fmt(snap.totalPnl))));

      // Non-CNY products show the CNY-converted view alongside native amounts.
      const fxLine = state.fx?.rate
        ? h('div', { className: 'ai-note' },
          `折人民币（汇率 ${fmt(state.fx.rate, 4)}）：现金 ≈ ${fmt(snap.cash * state.fx.rate)}`
          + ` · 持仓市值 ≈ ${fmt(snap.positionsValue * state.fx.rate)}`
          + ` · 累计收益 ≈ ${fmt(snap.totalPnl * state.fx.rate)}`)
        : null;

      const signals = (strat.signals ?? []).map(s => h('div', { key: s.id, className: 'ai-strat-cell' },
        h('span', { className: 'k' }, `${s.id} (权重${s.weight ?? 1})`),
        h('span', { className: 'ai-strat-text' }, JSON.stringify(s.params ?? {}))));

      const reflections = (state.reflections ?? []).slice(-6).reverse().map((r, i) => h('li', { key: i },
        h('span', { className: 'ai-src' }, `${new Date(r.ts).toLocaleString('zh-CN')} · ${r.trigger}${r.versionCreated ? ' · 新版本' : ''}`),
        h('div', { className: 'ai-strat-text' }, String(r.critique ?? '—'))));

      const trades = (state.trades ?? []).slice(0, 10).map((t, i) => h('tr', { key: i },
        h('td', null, new Date(t.ts).toLocaleString('zh-CN')),
        h('td', { className: t.side === 'buy' ? 'ai-up' : 'ai-down' }, t.side === 'buy' ? '买入' : '卖出'),
        h('td', null, t.symbol ?? '—'),
        h('td', null, fmt(t.price)),
        h('td', null, fmt(t.rmb))));

      const news = (state.news ?? []).slice(0, 8).map((n, i) => h('li', { key: i },
        h('a', { href: n.url, target: '_blank', rel: 'noreferrer' }, plain(n.title)),
        h('span', { className: 'ai-src' }, ` — ${n.source ?? ''}${newsWhen(n) ? ` · ${newsWhen(n)}` : ''}`)));

      return h('div', { className: 'ai-wrap' },
        h('style', null, CSS),
        h('h2', { className: 'ai-title' }, `自动投资机 · ${p.name ?? productId}`,
          h('span', { className: 'ai-src' },
            ` · ${state.tradingNow ? '交易中' : '休市'}${state.paused ? ' · 已暂停' : ''}${state.llm ? ` · 模型 ${state.llm.provider}/${state.llm.model}` : ''}`)),

        card('brand', '持仓与收益', h('span', { className: 'ai-src' }, snap.currency ?? p.currency ?? ''), [
          metrics,
          fxLine,
          positions.length === 0
            ? h('div', { className: 'ai-flat' }, '空仓')
            : table(['标的', '数量', '成本', '现价', '盈亏'], positionRows),
        ]),

        card('grey', '行情走势', h('span', { className: 'ai-src' }, state.chartSymbol ?? ''), [
          h(Sparkline, { series: state.series, currency: p.currency }),
        ]),

        card('amber', '策略版本', h('span', { className: 'ai-src' }, `v${cur.id ?? '-'} / 共 ${(state.versions ?? []).length} 个`), [
          h('div', { className: 'ai-strat-grid' }, signals),
          strat.risk
            ? h('div', { className: 'ai-note' }, `风控：止损 ${strat.risk.stopLossPct ?? '-'}% · 止盈 ${strat.risk.takeProfitPct ?? '-'}% · 单笔 ${strat.risk.perTrade ?? '-'}`)
            : null,
          cur.critique ? h('div', { className: 'ai-note' }, `复盘结论：${cur.critique}`) : null,
        ]),

        card('red', '复盘记录', h('span', { className: 'ai-src' }, `共 ${(state.reflections ?? []).length} 次`), [
          (state.reflections ?? []).length === 0 ? h('div', { className: 'ai-flat' }, '暂无复盘') : h('ul', { className: 'ai-news' }, reflections),
        ]),

        card('grey', '交易记录', h('span', { className: 'ai-src' }, `共 ${(state.trades ?? []).length} 笔`), [
          (state.trades ?? []).length === 0
            ? h('div', { className: 'ai-flat' }, '暂无成交')
            : table(['时间', '方向', '标的', '价格', '金额'], trades),
        ]),

        card('grey', '最新资讯', h('span', { className: 'ai-src' }, `共 ${(state.news ?? []).length} 条`), [
          (state.news ?? []).length === 0 ? h('div', { className: 'ai-flat' }, '暂无相关资讯') : h('ul', { className: 'ai-news' }, news),
        ]),

        card('brand', '操作', null, [
          h('div', null,
            h('button', { className: 'ai-btn primary', disabled: busy, onClick: () => act('run') }, '立即分析'),
            h('button', { className: 'ai-btn', disabled: busy, onClick: () => act('reflect') }, '立即复盘'),
            h('button', { className: 'ai-btn', disabled: busy, onClick: () => act(state.paused ? 'resume' : 'pause') }, state.paused ? '恢复自动循环' : '暂停自动循环')),
          notice ? h('div', { className: 'ai-note' }, notice) : null,
          h('div', { className: 'ai-note' },
            '下单由策略引擎自动执行，用户无需也不能手动买卖；成交受交易时段、手数、费用、涨跌停、单笔与敞口上限约束。'),
        ]));
    }

    /** One plugin page: a product switcher on top, the selected dashboard below. */
    const FALLBACK_PRODUCTS = [
      { id: 'gold', name: '黄金' },
      { id: 'ashare', name: 'A股' },
      { id: 'us', name: '美股' },
      { id: 'hk', name: '港股' },
    ];

    function AutoInvestorPage() {
      const [products, setProducts] = React.useState(FALLBACK_PRODUCTS);
      const [active, setActive] = React.useState(readActive() ?? 'gold');

      React.useEffect(() => {
        let alive = true;
        fetch('/api/auto-investor/products', { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : null))
          .then((body) => {
            if (!alive || !body?.products?.length) return;
            setProducts(body.products);
            setActive(prev => (body.products.some(p => p.id === prev) ? prev : body.products[0].id));
          })
          .catch(() => { /* keep the static fallback list */ });
        return () => { alive = false; };
      }, []);

      const select = (id) => {
        setActive(id);
        writeActive(id);
      };

      return h('div', null,
        h('style', null, CSS),
        h('div', { className: 'ai-tabs' },
          products.map(p => h('button', {
            key: p.id,
            className: `ai-tab${p.id === active ? ' active' : ''}`,
            onClick: () => select(p.id),
          }, p.name))),
        h(ProductDashboard, { key: active, productId: active }));
    }

    function readActive() {
      try { return globalThis.localStorage?.getItem('auto-investor:product') ?? null; } catch { return null; }
    }

    function writeActive(id) {
      try { globalThis.localStorage?.setItem('auto-investor:product', id); } catch { /* non-fatal */ }
    }

    function Strip() {
      const [states, setStates] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const res = await fetch('/api/auto-investor/products', { cache: 'no-store' });
            if (!res.ok) return;
            const { products } = await res.json();
            const list = (products ?? []).slice(0, 4);
            const loaded = await Promise.all(list.map(async (p) => {
              try {
                return await fetchProductState(p.id);
              } catch {
                return null;
              }
            }));
            if (alive) setStates(loaded.filter(Boolean));
          } catch { /* strip is decorative */ }
        };
        load();
        const t = setInterval(load, 20_000);
        return () => { alive = false; clearInterval(t); };
      }, []);
      if (!states?.length) return null;
      return h('div', { className: 'ai-strip' },
        h('style', null, CSS),
        h('span', null, '🪙 自动投资机'),
        ...states.map(s => h('span', { key: s.product?.id },
          `${s.product?.name ?? ''} `,
          h('b', { className: pnlClass(s.snapshot?.totalPnl) }, fmt(s.snapshot?.totalPnl)))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = (zh, en) => {
          try {
            const loc = ctx.get('locale')?.getSnapshot?.()?.locale ?? 'zh';
            return loc.startsWith('zh') ? zh : en;
          } catch {
            return zh;
          }
        };
        // One plugin page with an in-page product switcher (single tab).
        ctx.effect(() => ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'auto-investor-dashboard',
            order: 40,
            label: () => t('自动投资机', 'Auto investor'),
          }, AutoInvestorPage)), 'auto-investor: dashboard view');
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'auto-investor-strip',
            order: 40,
          }, Strip)), 'auto-investor: composer strip');
      },
    };
  },
});
