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
    `;

    async function fetchState() {
      const res = await fetch('/api/auto-investor/state');
      if (!res.ok) throw new Error(`state ${res.status}`);
      return res.json();
    }

    async function postAction(body) {
      const res = await fetch('/api/auto-investor/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    }

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

    function Dashboard() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const s = await fetchState();
            if (alive) { setState(s); setError(null); }
          } catch (e) {
            if (alive) setError(String(e.message ?? e));
          }
        };
        load();
        const t = setInterval(load, 10_000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      const act = async (body) => {
        setBusy(true);
        setNotice(null);
        try {
          const res = await postAction(body);
          if (res?.ok === false) setNotice(res.reason ?? '操作被拒绝');
          else if (res?.result?.rejection) setNotice(res.result.rejection);
          setState(await fetchState());
        } catch (e) {
          setNotice(`操作失败: ${String(e.message ?? e)}`);
        } finally {
          setBusy(false);
        }
      };

      const planLabel = state?.plan
        ? `${state.plan.style === 'swing' ? '波段' : state.plan.style === 'day' ? '日内' : '配置'} · 每日≤${state.plan.maxTradesPerDay}笔 · 间隔≥${state.plan.minIntervalHours}h`
        : null;

      return h('div', { className: 'ai-wrap' },
        h('style', null, CSS),
        h('h2', { className: 'ai-h' },
          h('span', { className: 'ai-live' }),
          '自动投资机 — 黄金模拟投资'),
        error ? h('div', { className: 'ai-card ai-acc-red' },
          h(Section, { accent: 'red', title: '数据加载异常' }),
          h('div', { className: 'ai-body ai-down' }, error)) : null,
        notice ? h('div', { className: 'ai-card ai-acc-amber' },
          h(Section, { accent: 'amber', title: '操作结果' }),
          h('div', { className: 'ai-body ai-reason' }, notice)) : null,
        !state ? h('div', { className: 'ai-card' }, h('div', { className: 'ai-body' }, '加载中…')) : h(React.Fragment, null,

          /* ── 持仓概览 ── */
          h('div', { className: 'ai-card ai-acc-brand' },
            h(Section, {
              accent: 'brand', title: '持仓概览',
              right: planLabel ? h('span', { className: 'ai-badge plan' }, planLabel) : null,
            }),
            h('div', { className: 'ai-body' },
              h('div', { className: 'ai-row' },
                h(Metric, { label: '持仓金额(元)', value: fmt(state.portfolio.marketValue) }),
                h(Metric, { label: '持仓克重(克)', value: fmt(state.portfolio.grams, 4) }),
                h(Metric, { label: '成本均价(元/克)', value: fmt(state.portfolio.costAvg) }),
                h(Metric, {
                  label: '今日收益(元)', value: fmt(state.portfolio.todayPnl),
                  cls: pnlClass(state.portfolio.todayPnl),
                }),
                h(Metric, {
                  label: '持仓收益(元)', value: fmt(state.portfolio.holdingPnl),
                  cls: pnlClass(state.portfolio.holdingPnl),
                }),
                h(Metric, {
                  label: '累计收益(元)', value: fmt(state.portfolio.totalPnl),
                  cls: pnlClass(state.portfolio.totalPnl),
                })),
              h('div', { className: 'ai-row', style: { marginTop: 10 } },
                h(Metric, { label: '实时买入价(元/克)', value: fmt(state.quote?.buy) }),
                h(Metric, { label: '实时卖出价(元/克)', value: fmt(state.quote?.sell) }),
                h(Metric, {
                  label: '累计投资(元)',
                  value: `${fmt(state.portfolio.investedRmb, 0)} / ${state.cfg.totalLimitRmb}`,
                }),
                h(Metric, {
                  label: '基准对照(金价自首笔)',
                  value: state.benchmarkReturnPct != null ? `${fmt(state.benchmarkReturnPct)}%` : '--',
                  cls: pnlClass(state.benchmarkReturnPct),
                }),
                h(Metric, {
                  label: '交易时段',
                  value: state.paused ? '已熔断' : (state.tradingNow ? '可交易' : '休市'),
                  cls: state.paused ? 'ai-down' : (state.tradingNow ? 'ai-up' : 'ai-flat'),
                }))),

          /* ── 价格走势 ── */
          h('div', { className: 'ai-card ai-acc-green' },
            h(Section, { accent: 'green', title: '价格走势 (元/克)' }),
            h('div', { className: 'ai-body' },
              h(Chart, { chart: state.chart }),
              h('div', { className: 'ai-note' },
                `纵轴：元/克 · 横轴：北京时间 · 已累计 ${state.ticks.length} 个行情点`))),

          /* ── 操作（只控制分析与循环，不允许手动下单） ── */
          h('div', { className: 'ai-card ai-acc-brand' },
            h(Section, { accent: 'brand', title: '操作' }),
            h('div', { className: 'ai-body' },
              h('button', { className: 'ai-btn primary', disabled: busy, onClick: () => act({ kind: 'run' }) }, '立即分析'),
              h('button', { className: 'ai-btn', disabled: busy, onClick: () => act({ kind: 'reflect' }) }, '立即复盘'),
              h('button', {
                className: 'ai-btn', disabled: busy,
                onClick: () => act({ kind: state.paused ? 'resume' : 'pause' }),
              }, state.paused ? '恢复自动循环' : '暂停自动循环'),
              h('div', { className: 'ai-note' },
                '下单由策略引擎自动执行，用户无需也不能手动买卖；成交仍受交易时段、单笔5000元、总额100000元及频率计划约束。'))),

          /* ── 策略版本（完整交易策略） ── */
          h('div', { className: 'ai-card ai-acc-amber' },
            h(Section, {
              accent: 'amber',
              title: '策略版本 — 完整交易策略',
              right: state.lastReflectAt
                ? h('span', { className: 'ai-src' },
                  `复盘: ${new Date(state.lastReflectAt).toLocaleString()} · 每 ${state.reflectIntervalHours ?? 24}h 或亏损触发`)
                : null,
            }),
            h('div', { className: 'ai-body' },
              (state.versions ?? []).length > 3
                ? h('div', { className: 'ai-note' }, `仅显示最近 3 个策略版本（共 ${state.versions.length} 个）`)
                : null,
              // Latest three versions, newest first — history stays in the API.
              (state.versions ?? []).slice(-3).reverse().map(v => h('div', { key: v.id, className: 'ai-strat' },
                h('div', { className: 'ai-strat-head' },
                  h('span', { className: 'ai-strat-id' }, `v${v.id}`),
                  v.reference
                    ? h('span', { className: 'ai-badge ref' }, '参考策略')
                    : v.retired
                      ? h('span', { className: 'ai-badge' }, '已迭代')
                      : h('span', { className: 'ai-badge' }, '运行中'),
                  h('span', { className: 'ai-src' },
                    `${new Date(v.createdAt).toLocaleString()}${v.strategy?.parentVersion ? ` ← 来源 v${v.strategy.parentVersion}` : ''}`)),
                h('div', { className: 'ai-strat-grid' },
                  h('div', { className: 'ai-strat-cell' },
                    h('span', { className: 'k' }, '决策'),
                    h('span', { className: 'v' },
                      `${v.strategy?.action ?? '--'}`
                      + `${v.strategy?.amountRmb ? ` ${v.strategy.amountRmb}元` : ''}`
                      + `${v.strategy?.grams ? ` ${v.strategy.grams}克` : ''}`)),
                  h('div', { className: 'ai-strat-cell' },
                    h('span', { className: 'k' }, '置信度/期限'),
                    h('span', { className: 'v' },
                      `${v.strategy?.confidence != null ? Math.round(v.strategy.confidence * 100) + '%' : '--'}`
                      + `${v.strategy?.horizonHours ? ` / ${v.strategy.horizonHours}h` : ''}`))),
                h('div', { className: 'ai-strat-cell' },
                  h('span', { className: 'k' }, '策略理由'),
                  h('span', { className: 'ai-strat-text' }, String(v.strategy?.reason ?? '—'))),
                v.strategy?.critique ? h('div', { className: 'ai-strat-cell' },
                  h('span', { className: 'k' }, '复盘结论'),
                  h('span', { className: 'ai-strat-text' }, String(v.strategy.critique))) : null,
                v.lastReview ? h('div', { className: 'ai-strat-cell' },
                  h('span', { className: 'k' }, `定期复盘 ${new Date(v.lastReview.ts).toLocaleString()}`),
                  h('span', { className: 'ai-strat-text' }, String(v.lastReview.critique ?? '计划无变化，沿用当前策略'))) : null,
                h('div', { className: 'ai-plan' },
                  h('span', { className: 'k' }, '交易计划'),
                  h('span', { className: 'ai-badge plan' },
                    v.strategy?.plan?.style === 'day' ? '日内' : v.strategy?.plan?.style === 'position' ? '中长线配置' : '波段'),
                  h('span', null, `每日≤${v.strategy?.plan?.maxTradesPerDay ?? '—'}笔`),
                  h('span', null, `间隔≥${v.strategy?.plan?.minIntervalHours ?? '—'}h`),
                  h('span', null, `仓位≤${v.strategy?.plan?.maxPositionPct ?? '—'}%`),
                  h('span', { className: 'ai-down' }, `止损${v.strategy?.plan?.stopLossPct ?? '—'}%`),
                  h('span', { className: 'ai-up' }, `止盈+${v.strategy?.plan?.takeProfitPct ?? '—'}%`)),
                h('div', { className: 'ai-strat-grid' },
                  h('div', { className: 'ai-strat-cell' },
                    h('span', { className: 'k' }, '轮次/成交'),
                    h('span', { className: 'v' }, `${v.display?.closes ?? v.trades ?? 0} / ${v.display?.fills ?? v.fills ?? 0}`)),
                  h('div', { className: 'ai-strat-cell' },
                    h('span', { className: 'k' }, '胜率'),
                    h('span', { className: 'v' },
                      v.display
                        ? (v.display.winRate == null ? '—' : `${Math.round(v.display.winRate * 100)}%`)
                        : (v.trades > 0 ? `${Math.round((v.wins / v.trades) * 100)}%` : '--'))),
                  h('div', { className: 'ai-strat-cell' },
                    h('span', { className: 'k' }, '收益(元)'),
                    h('span', { className: `v ${pnlClass(v.display?.returnPnl ?? v.returnPnl)}` },
                      fmt(v.display?.returnPnl ?? v.returnPnl))),
                  h('div', { className: 'ai-strat-cell' },
                    h('span', { className: 'k' }, '最大回撤(元)'),
                    h('span', { className: 'v ai-down' }, fmt(v.display?.maxDrawdownPnl ?? v.maxDrawdownPnl)))))))),

          /* ── 复盘记录（每次复盘的结论） ── */
          h('div', { className: 'ai-card ai-acc-red' },
            h(Section, {
              accent: 'red',
              title: '复盘记录 — 每次复盘的结论',
              right: h('span', { className: 'ai-src' }, `共 ${(state.reflections ?? []).length} 次`),
            }),
            h('div', { className: 'ai-body' },
              (state.reflections ?? []).length === 0
                ? h('div', { className: 'ai-flat' }, '暂无复盘记录')
                : (state.reflections ?? []).slice().reverse().map((r, i) =>
                  h('div', { key: `${r.ts}-${i}`, className: 'ai-strat' },
                    h('div', { className: 'ai-strat-head' },
                      h('span', { className: 'ai-strat-id' }, new Date(r.ts).toLocaleString()),
                      r.trigger === 'loss'
                        ? h('span', { className: 'ai-badge' }, '亏损触发')
                        : h('span', { className: 'ai-badge plan' }, '定期复盘'),
                      h('span', { className: 'ai-src' },
                        r.versionCreated
                          ? `v${r.fromVersion} → v${r.toVersion}`
                          : `沿用 v${r.fromVersion}（计划无变化）`)),
                    h('div', { className: 'ai-strat-cell' },
                      h('span', { className: 'k' }, '结论'),
                      h('span', { className: 'ai-strat-text' }, String(r.critique ?? '—'))),
                    h('div', { className: 'ai-strat-grid' },
                      h('div', { className: 'ai-strat-cell' },
                        h('span', { className: 'k' }, '触发时收益'),
                        h('span', { className: `v ${pnlClass(r.stats?.returnPct)}` },
                          `${fmt(r.stats?.returnPct)}%`)),
                      h('div', { className: 'ai-strat-cell' },
                        h('span', { className: 'k' }, '连亏'),
                        h('span', { className: 'v' }, String(r.stats?.consecLosses ?? 0))),
                      h('div', { className: 'ai-strat-cell' },
                        h('span', { className: 'k' }, '回撤'),
                        h('span', { className: 'v ai-down' }, `${fmt(r.stats?.maxDrawdownPct)}%`)),
                      h('div', { className: 'ai-strat-cell' },
                        h('span', { className: 'k' }, '新决策'),
                        h('span', { className: 'v' }, String(r.action ?? '—'))))))),),

          /* ── 最近交易 ── */
          h('div', { className: 'ai-card ai-acc-red' },
            h(Section, { accent: 'red', title: '最近交易' }),
            h('div', { className: 'ai-body' },
              state.trades.length === 0
                ? h('div', { className: 'ai-flat' }, '暂无交易')
                : h('table', { className: 'ai-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, '时间'), h('th', null, '方向'), h('th', null, '克重'),
                    h('th', null, '价格(元/克)'), h('th', null, '金额(元)'), h('th', null, '决策理由'))),
                  h('tbody', null, state.trades.slice(0, 10).map((t, i) =>
                    h('tr', { key: i },
                      h('td', null, new Date(t.ts).toLocaleString()),
                      h('td', null, t.side === 'buy' ? '买入' : t.side === 'sell' ? '卖出' : t.side),
                      h('td', null, fmt(t.grams, 4)),
                      h('td', null, fmt(t.price)),
                      h('td', null, fmt(t.rmb, 0)),
                      h('td', { className: 'ai-reason' }, String(t.note ?? '').slice(0, 60)))))))),

          /* ── 最新资讯 ── */
          h('div', { className: 'ai-card ai-acc-grey' },
            h(Section, { accent: 'grey', title: '最新资讯 (已筛选与黄金投资相关内容)' }),
            h('div', { className: 'ai-body' },
              state.news.length === 0
                ? h('div', { className: 'ai-flat' }, '暂无相关资讯')
                : h('ul', { className: 'ai-news' }, state.news.slice(0, 8).map((n, i) =>
                  h('li', { key: i },
                    h('a', { href: n.url, target: '_blank', rel: 'noreferrer' }, plain(n.title)),
                    h('span', { className: 'ai-src' },
                      ` — ${n.source ?? ''}${newsWhen(n) ? ` · ${newsWhen(n)}` : ''}`)))))))));
    }

    function Strip() {
      const [state, setState] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const s = await fetchState();
            if (alive) setState(s);
          } catch { /* strip is decorative */ }
        };
        load();
        const t = setInterval(load, 15_000);
        return () => { alive = false; clearInterval(t); };
      }, []);
      if (!state?.quote) return null;
      return h('div', { className: 'ai-strip' },
        h('style', null, CSS),
        h('span', null, '🪙 自动投资机'),
        h('span', null, '买入 ', h('b', null, fmt(state.quote.buy))),
        h('span', null, '卖出 ', h('b', null, fmt(state.quote.sell))),
        h('span', null, '今日 ',
          h('b', { className: pnlClass(state.portfolio.todayPnl) }, fmt(state.portfolio.todayPnl))),
        h('span', null, '持仓 ',
          h('b', { className: pnlClass(state.portfolio.holdingPnl) }, fmt(state.portfolio.holdingPnl))));
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
        ctx.effect(() => ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'auto-investor-dashboard',
            order: 40,
            label: () => t('自动投资机', 'Auto investor'),
          }, Dashboard)), 'auto-investor: dashboard view');
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
