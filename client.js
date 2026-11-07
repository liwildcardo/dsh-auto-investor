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
      .ai-wrap { padding: 24px; color: var(--dsw-alias-label-primary); font-size: 13px;
        line-height: 1.55; display: flex; flex-direction: column; gap: 18px; max-width: 1080px; }
      .ai-head { display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px; flex-wrap: wrap; }
      .ai-title { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .2px;
        display: flex; align-items: center; gap: 10px; }
      .ai-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px; }
      .ai-pills { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .ai-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
        border-radius: 999px; font-size: 11px; font-weight: 600;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-secondary); }
      .ai-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
      .ai-pill.ok { color: var(--dsw-alias-state-success-primary); }
      .ai-pill.warn { color: var(--dsw-alias-state-warn-primary); }
      .ai-pill.err { color: var(--dsw-alias-state-error-primary); }
      .ai-pill.brand { color: var(--dsw-alias-brand-primary); }

      .ai-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
      .ai-kpi { position: relative; padding: 14px 16px; border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        overflow: hidden; }
      .ai-kpi::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
        background: var(--dsw-alias-border-l2); }
      .ai-kpi.brand::before { background: var(--dsw-alias-brand-primary); }
      .ai-kpi.up::before, .ai-kpi.ai-up::before { background: var(--dsw-alias-state-success-primary); }
      .ai-kpi.down::before, .ai-kpi.ai-down::before { background: var(--dsw-alias-state-error-primary); }
      .ai-kpi .k { font-size: 11px; color: var(--dsw-alias-label-secondary); letter-spacing: .3px; }
      .ai-kpi .v { margin-top: 4px; font-size: 21px; font-weight: 700;
        font-variant-numeric: tabular-nums; }
      .ai-kpi .s { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }

      .ai-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 16px; align-items: start; }
      @media (max-width: 900px) { .ai-grid { grid-template-columns: 1fr; } }

      .ai-card { background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; overflow: hidden; }
      .ai-card > .ai-sec { display: flex; align-items: center; gap: 8px;
        padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        font-size: 13px; font-weight: 600; background: var(--dsw-alias-bg-layer-2); }
      .ai-card > .ai-sec .ai-bar { width: 4px; height: 15px; border-radius: 2px; }
      .ai-card > .ai-body { padding: 16px; }

      .ai-acc-brand  .ai-sec { color: var(--dsw-alias-brand-primary); }
      .ai-acc-brand  .ai-bar  { background: var(--dsw-alias-brand-primary); }
      .ai-acc-amber  .ai-sec { color: var(--dsw-alias-state-warn-primary); }
      .ai-acc-amber  .ai-bar  { background: var(--dsw-alias-state-warn-primary); }
      .ai-acc-red    .ai-sec { color: var(--dsw-alias-state-error-primary); }
      .ai-acc-red    .ai-bar  { background: var(--dsw-alias-state-error-primary); }
      .ai-acc-grey   .ai-sec { color: var(--dsw-alias-label-secondary); }
      .ai-acc-grey   .ai-bar  { background: var(--dsw-alias-state-idle-primary); }

      .ai-up { color: var(--dsw-alias-state-success-primary); }
      .ai-down { color: var(--dsw-alias-state-error-primary); }
      .ai-flat { color: var(--dsw-alias-label-secondary); }
      .ai-mono { font-variant-numeric: tabular-nums; }

      .ai-empty { padding: 26px 12px; text-align: center; color: var(--dsw-alias-label-secondary);
        border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2); font-size: 12px; }

      .ai-chart-wrap { position: relative; }
      .ai-chart { width: 100%; height: 190px; display: block; }
      .ai-chart .grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
      .ai-chart .axis-label { fill: var(--dsw-alias-label-secondary); font-size: 10px;
        font-variant-numeric: tabular-nums; }
      .ai-chart .line { stroke: currentColor; stroke-width: 2; fill: none;
        stroke-linejoin: round; stroke-linecap: round; }
      .ai-chart .area { fill: currentColor; opacity: .10; }
      .ai-chart .last-dot { fill: currentColor; }

      .ai-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .ai-table th { text-align: left; color: var(--dsw-alias-label-secondary);
        font-weight: 600; font-size: 11px; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
      .ai-table td { padding: 9px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        font-variant-numeric: tabular-nums; }
      .ai-table tbody tr:nth-child(even) { background: var(--dsw-alias-bg-layer-2); }
      .ai-table tbody tr:hover { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
      .ai-table tr:last-child td { border-bottom: none; }
      .ai-table .num { text-align: right; }

      .ai-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary); border-radius: 10px; padding: 9px 18px;
        cursor: pointer; font-size: 12.5px; font-weight: 600; margin: 0 8px 8px 0;
        transition: border-color .15s, background .15s, color .15s; }
      .ai-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .ai-btn:disabled { opacity: .5; cursor: default; }
      .ai-btn.primary { background: var(--dsw-alias-brand-primary);
        border-color: var(--dsw-alias-brand-primary); color: #fff; }
      .ai-btn.primary:hover { opacity: .9; color: #fff; }

      .ai-badge { display: inline-block; padding: 1px 9px; border-radius: 99px; font-size: 11px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
      .ai-badge.ref { border-color: var(--dsw-alias-state-warn-primary);
        color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
      .ai-badge.plan { border-color: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-brand-primary); }

      .ai-news { list-style: none; margin: 0; padding: 0; }
      .ai-news li { padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); line-height: 1.5; }
      .ai-news li:last-child { border-bottom: none; }
      .ai-news a { color: var(--dsw-alias-label-primary); text-decoration: none; font-weight: 500; }
      .ai-news a:hover { color: var(--dsw-alias-brand-primary); }
      .ai-chip { display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 99px;
        font-size: 10.5px; color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
      .ai-src { color: var(--dsw-alias-label-secondary); font-size: 11px; }

      .ai-note { color: var(--dsw-alias-label-secondary); font-size: 11.5px; margin-top: 8px; }
      .ai-reason { color: var(--dsw-alias-label-secondary); line-height: 1.6; }

      .ai-strat-grid { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 2px; }
      .ai-strat-cell { display: inline-flex; gap: 6px; align-items: baseline; padding: 5px 9px;
        border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; }
      .ai-strat-cell .k { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .ai-strat-cell .v { font-weight: 600; font-variant-numeric: tabular-nums; }
      .ai-strat-text { color: var(--dsw-alias-label-primary); line-height: 1.6; font-size: 12.5px; }
      .ai-plan { display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
        padding: 8px 10px; margin: 8px 0; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        font-size: 12px; font-variant-numeric: tabular-nums; }
      .ai-plan .k { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; }

      .ai-strip { display: flex; gap: 10px; align-items: center; padding: 6px 14px;
        color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums;
        flex-wrap: wrap; }
      .ai-strip .ai-strip-title { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ai-strip .ai-strip-item { display: inline-flex; gap: 6px; align-items: baseline;
        padding: 2px 9px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); }
      .ai-strip b { color: var(--dsw-alias-label-primary); font-weight: 600; }

      .ai-tabs { display: flex; gap: 4px; padding: 4px; margin: 16px 24px 0;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 999px; width: fit-content; max-width: calc(100% - 48px); flex-wrap: wrap; }
      .ai-tab { padding: 7px 16px; border-radius: 999px; cursor: pointer; border: none;
        background: transparent; color: var(--dsw-alias-label-secondary);
        font-size: 13px; font-weight: 600; transition: background .15s, color .15s; }
      .ai-tab:hover { color: var(--dsw-alias-label-primary); }
      .ai-tab.active { background: var(--dsw-alias-brand-primary); color: #fff; }
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
      if (pts.length < 2) return h('div', { className: 'ai-empty' }, '暂无行情数据');
      const w = 640;
      const hgt = 190;
      const padX = 12;
      const padY = 22;
      const ys = pts.map(p => p.price);
      const min = Math.min(...ys);
      const max = Math.max(...ys);
      const span = max - min || 1;
      const xOf = (i) => padX + (i / (pts.length - 1)) * (w - padX * 2);
      const yOf = (v) => padY + (1 - (v - min) / span) * (hgt - padY * 2);
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.price).toFixed(1)}`).join(' ');
      const area = `${line} L${xOf(pts.length - 1).toFixed(1)},${hgt - padY} L${xOf(0).toFixed(1)},${hgt - padY} Z`;
      const lastP = pts[pts.length - 1];
      const tOf = (ts) => {
        if (!Number.isFinite(ts)) return '';
        const d = new Date(ts + 8 * 3600_000);
        const p = (x) => String(x).padStart(2, '0');
        return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
      };
      const up = lastP.price >= pts[0].price;
      return h('div', { className: 'ai-chart-wrap' },
        // Three gridlines for orientation; labels show the range.
        h('svg', {
          viewBox: `0 0 ${w} ${hgt}`,
          className: 'ai-chart',
          style: { color: up ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' },
        },
        [0.25, 0.5, 0.75].map(f => h('line', {
          key: f, className: 'grid', x1: padX, x2: w - padX,
          y1: padY + f * (hgt - padY * 2), y2: padY + f * (hgt - padY * 2),
        })),
        h('path', { className: 'area', d: area }),
        h('path', { className: 'line', d: line }),
        h('circle', { className: 'last-dot', cx: xOf(pts.length - 1), cy: yOf(lastP.price), r: 3.5 }),
        h('text', { className: 'axis-label', x: padX, y: padY - 6 }, `${fmt(min)}`),
        h('text', { className: 'axis-label', x: w - padX, y: padY - 6, textAnchor: 'end' }, `${fmt(max)}`),
        h('text', { className: 'axis-label', x: padX, y: hgt - 4 }, tOf(pts[0].ts)),
        h('text', { className: 'axis-label', x: w - padX, y: hgt - 4, textAnchor: 'end' }, tOf(lastP.ts))),
        h('div', { className: 'ai-note' },
          `${currency ?? ''} 最新 ${fmt(lastP.price)} · 区间 ${fmt(min)} ~ ${fmt(max)}`));
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
          h('div', { className: 'ai-empty' }, disabled
            ? '该产品未启用（可在插件配置 products 中启用）'
            : `加载失败：${error}`));
      }
      if (!state) {
        return h('div', { className: 'ai-wrap' }, h('style', null, CSS),
          h('div', { className: 'ai-empty' }, '加载中…'));
      }

      const p = state.product ?? {};
      const snap = state.snapshot ?? { positions: [] };
      const positions = snap.positions ?? [];
      const cur = state.currentVersion ?? {};
      const strat = cur.strategy ?? {};
      const fmtQty = (v) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : '--');
      const updated = Number.isFinite(state.quoteTs)
        ? new Date(state.quoteTs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '--';
      const fx = state.fx?.rate;

      const table = (head, rows) => h('table', { className: 'ai-table' },
        h('thead', null, h('tr', null, head.map(x => h('th', { key: x }, x)))),
        h('tbody', null, rows));
      const card = (accent, title, right, children) => h('div', { className: `ai-card ai-acc-${accent}` },
        h(Section, { accent, title, right }),
        h('div', { className: 'ai-body' }, ...children));
      const pill = (cls, text) => h('span', { className: `ai-pill${cls ? ` ${cls}` : ''}` },
        h('span', { className: 'dot' }), text);
      const kpi = (label, value, cls, sub) => h('div', { className: `ai-kpi${cls ? ` ${cls}` : ''}` },
        h('div', { className: 'k' }, label),
        h('div', { className: 'v' }, value),
        sub ? h('div', { className: 's' }, sub) : null);

      const header = h('div', { className: 'ai-head' },
        h('div', null,
          h('h2', { className: 'ai-title' }, `自动投资机 · ${p.name ?? productId}`),
          h('div', { className: 'ai-sub' },
            `${snap.currency ?? p.currency ?? ''} 计价 · 行情更新 ${updated}`)),
        h('div', { className: 'ai-pills' },
          state.tradingNow ? pill('ok', '交易中') : pill('', '休市'),
          state.paused ? pill('warn', '已暂停') : null,
          state.llm ? pill('brand', `模型 ${state.llm.provider}/${state.llm.model}`) : null));

      const kpis = h('div', { className: 'ai-kpis' },
        kpi('总资产', fmt(snap.totalValue), 'brand', fx ? `≈ ¥${fmt(snap.totalValue * fx)}` : null),
        kpi('现金', fmt(snap.cash), null, fx ? `≈ ¥${fmt(snap.cash * fx)}` : null),
        kpi('持仓市值', fmt(snap.positionsValue), null, `${positions.length} 个持仓`),
        kpi('今日收益', fmt(snap.todayPnl), pnlClass(snap.todayPnl),
          fx ? `≈ ¥${fmt(snap.todayPnl * fx)}` : null),
        kpi('累计收益', fmt(snap.totalPnl), pnlClass(snap.totalPnl),
          `已实现 ${fmt(snap.realizedPnl)}`));

      const fxNote = fx
        ? h('div', { className: 'ai-note' },
          `折人民币按汇率 ${fmt(fx, 4)} 估算（每 30 分钟刷新）。`)
        : null;

      const positionRows = positions.map(pos => h('tr', { key: pos.symbol },
        h('td', null, pos.symbol),
        h('td', { className: 'num' }, fmtQty(pos.qty)),
        h('td', { className: 'num' }, fmt(pos.costAvg)),
        h('td', { className: 'num' }, fmt(pos.price)),
        h('td', { className: `num ${pnlClass(pos.pnl)}` }, fmt(pos.pnl))));

      const signals = (strat.signals ?? []).map(s => h('div', { key: s.id, className: 'ai-strat-cell' },
        h('span', { className: 'k' }, `${s.id} · 权重 ${s.weight ?? 1}`),
        h('span', { className: 'v' }, JSON.stringify(s.params ?? {}))));

      // Only the most recent review is shown; the full journal stays in the API.
      const reflections = (state.reflections ?? []).slice(-1).map((r, i) => h('li', { key: i },
        h('div', null,
          h('span', { className: 'ai-src' }, new Date(r.ts).toLocaleString('zh-CN')),
          h('span', { className: 'ai-chip' }, r.trigger === 'loss' ? '亏损触发' : r.trigger === 'periodic' ? '定期复盘' : '手动复盘'),
          r.versionCreated ? h('span', { className: 'ai-chip' }, '新版本') : null),
        h('div', { className: 'ai-strat-text' }, String(r.critique ?? '—'))));

      const trades = (state.trades ?? []).slice(0, 10).map((t, i) => h('tr', { key: i },
        h('td', null, new Date(t.ts).toLocaleString('zh-CN')),
        h('td', { className: t.side === 'buy' ? 'ai-up' : 'ai-down' }, t.side === 'buy' ? '买入' : '卖出'),
        h('td', null, t.symbol ?? '—'),
        h('td', { className: 'num' }, fmt(t.price)),
        h('td', { className: 'num' }, fmt(t.rmb))));

      const news = (state.news ?? []).slice(0, 8).map((n, i) => h('li', { key: i },
        h('a', { href: n.url, target: '_blank', rel: 'noreferrer' }, plain(n.title)),
        h('div', null,
          h('span', { className: 'ai-src' }, n.source ?? ''),
          h('span', { className: 'ai-chip' }, newsWhen(n) || '—'))));

      const riskLine = strat.risk
        ? h('div', { className: 'ai-plan' },
          h('span', null, h('span', { className: 'k' }, '止损 '), `${strat.risk.stopLossPct ?? '-'}%`),
          h('span', null, h('span', { className: 'k' }, '止盈 '), `${strat.risk.takeProfitPct ?? '-'}%`),
          h('span', null, h('span', { className: 'k' }, '单笔 '), String(strat.risk.perTrade ?? '-')),
          h('span', null, h('span', { className: 'k' }, '单标的 '), `${strat.risk.perSymbolPct ?? '-'}%`))
        : null;

      return h('div', { className: 'ai-wrap' },
        h('style', null, CSS),
        header,
        kpis,
        fxNote,

        h('div', { className: 'ai-grid' },
          card('brand', '持仓', h('span', { className: 'ai-src' }, `${positions.length} 个`), [
            positions.length === 0
              ? h('div', { className: 'ai-empty' }, '空仓 — 引擎会在信号满足条件时自动建仓')
              : table(['标的', '数量', '成本', '现价', '盈亏'], positionRows),
          ]),
          card('grey', '行情走势', h('span', { className: 'ai-src' }, state.chartSymbol ?? ''), [
            h(Sparkline, { series: state.series, currency: p.currency }),
          ])),

        h('div', { className: 'ai-grid' },
          card('amber', '策略版本', h('span', { className: 'ai-src' }, `v${cur.id ?? '-'} / 共 ${(state.versions ?? []).length} 个`), [
            riskLine,
            h('div', { className: 'ai-strat-grid' }, signals),
            cur.critique
              ? h('div', { className: 'ai-note' }, `最近复盘结论：${cur.critique}`)
              : h('div', { className: 'ai-empty' }, '该版本还没有复盘结论'),
          ]),
          card('red', '复盘记录', h('span', { className: 'ai-src' }, `共 ${(state.reflections ?? []).length} 次`), [
            (state.reflections ?? []).length === 0
              ? h('div', { className: 'ai-empty' }, '暂无复盘')
              : h('ul', { className: 'ai-news' }, reflections),
          ])),

        h('div', { className: 'ai-grid' },
          card('grey', '交易记录', h('span', { className: 'ai-src' }, `共 ${(state.trades ?? []).length} 笔`), [
            (state.trades ?? []).length === 0
              ? h('div', { className: 'ai-empty' }, '暂无成交')
              : table(['时间', '方向', '标的', '价格', '金额'], trades),
          ]),
          card('grey', '最新资讯', h('span', { className: 'ai-src' }, `共 ${(state.news ?? []).length} 条`), [
            (state.news ?? []).length === 0
              ? h('div', { className: 'ai-empty' }, '暂无相关资讯')
              : h('ul', { className: 'ai-news' }, news),
          ])),

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
        h('span', { className: 'ai-strip-title' }, '🪙 自动投资机'),
        ...states.map(s => h('span', { key: s.product?.id, className: 'ai-strip-item' },
          s.product?.name ?? '',
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
