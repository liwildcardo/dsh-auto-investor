/**
 * 通用产品引擎：一个产品 = 一个账户 + 一套规则。
 * 流程：行情 → 指标/信号 → 候选 → 资讯 → LLM 决策 → 风控闸门 → 模拟成交 → 版本绩效。
 * 引擎不含任何产品专有常量，全部来自产品契约。
 */
import { createAccount, applyBuy, applySell, snapshotOf, positionOf } from './account.js';
import { evaluateSignals, compositeScore, pickCandidates, volatility } from './signals.js';
import { isSessionOpen, sessionDateOf, roundLot, tradeFees, earliestSellTs, withinPriceBand, zonedEpoch } from './market-rules.js';
import { zonedParts } from './market-rules.js';
import { jsonSafe } from '../lib/json.js';
import { fetchDailyHistory, fetchMinuteHistory, fetchFxRate, fetchEmDaily } from './quotes.js';
import { loadWatchlist, addToWatchlist, removeFromWatchlist, resetWatchlist } from './watchlist.js';
import { runBacktest as runBacktestCore } from './backtest.js';
import { collectFactors, readFactors } from './factor-sources.js';

const DEFAULT_SERIES = 240;

export function createProductEngine({
  db, product, llm, fetchFn, now = () => Date.now(), searchFn = undefined,
  newsIngest = null, newsList = null, newsSearch = null, newsBackfill = null,
  newsPollMin = 15, llmInfo = null,
}) {
  const pkey = (k) => `product:${product.id}:${k}`;
  const cfg = product;
  let account = db.getState(pkey('account'))
    ?? createAccount({ currency: product.currency, initial: product.capital?.initialRmb ?? 100000 });
  let versions = db.getState(pkey('versions')) ?? [newVersion(1, product, now())];
  let paused = db.getState(pkey('paused')) ?? false;
  let dayLossHit = false;
  let quote = null;          // {price, buy, sell} for single, or {symbol → q}
  let quoteTs = 0;
  let lastIngest = null;
  let lastSearch = null; // last product web-search outcome (own slow timer)
  let lastRun = null;
  let lastReflectAt = db.getState(pkey('lastReflectAt')) ?? now();
  let fxRate = db.getState(pkey('fx')) ?? null; // {rate, ts} for non-CNY products
  // Macro factor snapshot (real yield / USD / inflation expectations): read
  // from cache here, refreshed once per cycle behind the 26h staleness gate.
  let factors = readFactors(db);

  const current = () => versions[versions.length - 1];
  // Version-evolved risk wins over the product defaults (whitelisted + clamped).
  const effectiveRisk = () => ({ ...(cfg.risk ?? {}), ...(current().strategy?.risk ?? {}) });
  // A migrated version may have no signals yet: fall back to the product's set.
  const activeSignals = () => {
    const v = current().strategy?.signals;
    return Array.isArray(v) && v.length ? v : (cfg.strategy.signals ?? []);
  };
  // Editable watchlist: persisted pool, falling back to product defaults.
  const pool = () => loadWatchlist(db, product);
  const poolNames = () => new Map(pool().map(w => [w.symbol, w.name]));
  const persist = () => {
    db.putState(pkey('account'), account);
    db.putState(pkey('versions'), versions.map(v => ({ ...v, strategy: stripFns(v.strategy) })));
    db.putState(pkey('paused'), paused);
    db.putState(pkey('lastReflectAt'), lastReflectAt);
  };
  const stripFns = (v) => JSON.parse(JSON.stringify(v ?? {}));

  /**
   * Versions migrated from the single-product era have no rule parameters
   * (`signals: []`, `risk: {}`). Backfill them from the product contract so the
   * engine evaluates real signals and reflection has whitelisted paths to edit.
   */
  function normalizeVersions() {
    let changed = false;
    for (const v of versions) {
      v.strategy ??= {};
      if (!Array.isArray(v.strategy.signals) || v.strategy.signals.length === 0) {
        v.strategy.signals = (cfg.strategy.signals ?? []).map(s => ({ ...s, params: { ...(s.params ?? {}) } }));
        changed = true;
      }
      if (!v.strategy.risk || Object.keys(v.strategy.risk).length === 0) {
        v.strategy.risk = { ...(cfg.risk ?? {}) };
        changed = true;
      } else {
        // Fill keys added to the contract after this version was forked
        // (evolved values win; new defaults fill the gaps).
        const merged = { ...(cfg.risk ?? {}), ...v.strategy.risk };
        if (Object.keys(merged).length !== Object.keys(v.strategy.risk).length) {
          v.strategy.risk = merged;
          changed = true;
        }
      }
      // Versions forked before plan-preservation lost the frequency plan; the
      // engine would then fall back to the loosest limits — restore the
      // product's default plan so daily-trade/interval discipline survives.
      if (!v.strategy.plan || Object.keys(v.strategy.plan).length === 0) {
        v.strategy.plan = { ...(cfg.strategy?.plan ?? {}) };
        changed = true;
      }
      // The candidate gate is part of the strategy (auditable, evolvable);
      // versions forked before it existed fall back to the product default.
      if (!Number.isFinite(v.strategy.candidates?.threshold)) {
        v.strategy.candidates = {
          ...(v.strategy.candidates ?? {}),
          threshold: cfg.strategy?.candidates?.threshold ?? 0.8,
        };
        changed = true;
      }
    }
    // Signal lists are frozen at version creation, but signals ADDED to the
    // product contract afterwards (e.g. batch-E factors) must join the ACTIVE
    // version — otherwise new factors never evaluate until the next fork.
    // Retired versions keep the list they actually ran with.
    const active = versions[versions.length - 1];
    if (active?.strategy?.signals) {
      const have = new Set(active.strategy.signals.map(s => s.id));
      const missing = (cfg.strategy.signals ?? []).filter(s => !have.has(s.id));
      if (missing.length) {
        active.strategy.signals = [
          ...active.strategy.signals,
          ...missing.map(s => ({ ...s, params: { ...(s.params ?? {}) } })),
        ];
        changed = true;
      }
    }
    // Historical forks predate `version.critique` (added 2026-11-12): recover
    // the reasons from the reflection journal so the paged 策略版本 card can
    // show WHY each old version exists. Journal versionCreated entries map to
    // versions[1..] in creation order; entries are consumed in lockstep so a
    // version that already carries a critique still advances the pointer.
    const journal = db.getState(pkey('reflections')) ?? [];
    if (journal.length && versions.length > 1) {
      let ji = 0;
      for (let vi = 1; vi < versions.length && ji < journal.length; vi += 1) {
        while (ji < journal.length && !journal[ji].versionCreated) ji += 1;
        if (ji >= journal.length) break;
        const e = journal[ji];
        ji += 1;
        if (versions[vi].critique == null && e.critique) {
          versions[vi].critique = e.critique;
          changed = true;
        }
      }
    }
    if (changed) persist();
  }
  normalizeVersions();

  // One-time benchmark backfill: fills that happened before the benchmark
  // existed never seeded it — take the product's first recorded buy.
  if (!db.getState(pkey('benchmark'))) {
    const buys = db.listTradesByProduct(product.id, 5000).filter(t => t.side === 'buy' && Number.isFinite(t.price));
    const first = buys[buys.length - 1]; // DESC order → oldest buy last
    if (first) db.putState(pkey('benchmark'), { symbol: first.symbol ?? pool()[0]?.symbol ?? product.id, price: first.price, ts: first.ts });
  }

  function newVersion(id, p, ts) {
    return {
      id,
      createdAt: ts,
      strategy: {
        signals: (p.strategy?.signals ?? []).map(s => ({ ...s, params: { ...(s.params ?? {}) } })),
        risk: { ...(p.risk ?? {}) },
        plan: { ...(p.strategy?.plan ?? {}) },
        candidates: { ...(p.strategy?.candidates ?? {}) },
      },
      critique: null,
      startPnl: 0,
      retired: false,
    };
  }

  const priceOf = (symbol) => {
    if (!quote) return null;
    if (product.market.kind === 'single') return quote.price;
    return quote[symbol]?.price ?? null;
  };
  const prevCloseOf = (symbol) => (product.market.kind === 'single' ? null : quote?.[symbol]?.prevClose ?? null);

  /* ------------------------------ market data ------------------------------ */

  /**
   * Seed history once per symbol so signal bars work immediately.
   * single 产品（黄金）走 market.dailySeed：日线种子写 **series 表**（带
   * OHLCV），绝不写 ticks —— barsFor('1h') 只读 ticks，跨零点回绕
   * （gold 09:10–次日02:00）会让周二至周五的午夜行混入 1h 桶，结构隔离
   * 才能保住 1h 序列的时间含义；日开盘基准也只读 ticks，不受影响。
   */
  async function seedHistory() {
    if (product.market.kind === 'single') return seedDailyHistory();
    for (const w of pool().slice(0, 20)) {
      if (barsFor(w.symbol).length >= 30) continue; // enough signal bars already
      const key = pkey(`seeded:${w.symbol}`);
      const seededAt = db.getState(key) ?? 0;
      if (now() - seededAt < 30 * 60_000) continue; // retry at most every 30 min
      try {
        let rows = await fetchDailyHistory(fetchFn, w.symbol, 120).catch(() => []);
        if (rows.length < 30) {
          const minutes = await fetchMinuteHistory(fetchFn, w.symbol, cfg.timezone).catch(() => []);
          rows = [...rows, ...minutes];
        }
        for (const r of rows) {
          db.insertPoint({
            ts: r.ts, product: cfg.id, symbol: w.symbol,
            price: r.price, open: r.open ?? null, volume: r.volume ?? null,
          });
        }
      } catch { /* leave unseeded */ } finally {
        // Record the attempt even on failure so a dead endpoint is not retried
        // on every price tick (throttled to once per 30 minutes).
        db.putState(key, now());
      }
    }
  }

  /**
   * Single-product daily seed (gold): fills the series table so '1d' bars
   * (backtest) carry years of history instead of 240 hourly bars.
   * Gates: ≥60 '1d' bars → done; otherwise a 30-minute throttle key
   * (recorded even on failure, so a dead endpoint is not hammered).
   */
  async function seedDailyHistory() {
    const seed = product.market?.dailySeed;
    if (!seed || seed.kind !== 'em' || !seed.secid) return;
    const symbol = pool()[0]?.symbol ?? product.id;
    if (barsFor(symbol, '1d').length >= 60) return;
    const key = pkey('seeded:daily');
    const seededAt = db.getState(key) ?? 0;
    if (now() - seededAt < 30 * 60_000) return;
    try {
      const rows = await fetchEmDaily(fetchFn, seed.secid, 400, cfg.timezone);
      // 瘦源重抓：按 ts 去重，重复行不再插入（否则行数/存储随重抓膨胀）。
      const existing = new Set(db.listPoints(cfg.id, symbol, 5000).map((p) => p.ts));
      for (const r of rows) {
        if (existing.has(r.ts)) continue;
        db.insertPoint({
          ts: r.ts, product: cfg.id, symbol,
          price: r.price, open: r.open, high: r.high, low: r.low, volume: r.volume, pe: null,
        });
      }
    } catch { /* seed failure → next cycle retries (throttle recorded below) */ } finally {
      db.putState(key, now());
    }
  }

  async function tick() {
    const raw = await product.market.quote(fetchFn, cfg);
    quoteTs = now();
    // Day-open baselines are only recorded while the market is actually open:
    // the first in-session tick is the session open, a midnight/closed tick is
    // a stale quote that must not become "today's" baseline.
    const sessionOpen = isSessionOpen(cfg.rules, now(), cfg.timezone);
    // Out-of-session polls carry a frozen quote: inserting them flooded the
    // DB (~2.8k identical rows/day) and pushed every in-session point out of
    // the chart's count window — the "straight line" bug. Skip them entirely;
    // the last in-session point IS the official close.
    if (product.market.kind === 'single') {
      quote = raw;
      if (sessionOpen) {
        db.insertTick({ ts: quoteTs, mid: raw.price, buy: raw.buy, sell: raw.sell, product: product.id });
        recordDayOpen({ [pool()[0]?.symbol ?? product.id]: raw.price });
      }
    } else {
      quote = Object.fromEntries(raw.quotes.map(q => [q.symbol, q]));
      if (sessionOpen) {
        for (const q of raw.quotes) {
          db.insertPoint({
            ts: quoteTs, product: product.id, symbol: q.symbol,
            price: q.price, open: q.open, volume: q.volume, pe: q.pe ?? null,
          });
        }
        recordDayOpen(Object.fromEntries(raw.quotes.map(q => [q.symbol, q.price])));
      }
    }
    await seedHistory().catch(() => {});
    await refreshFx().catch(() => {});
    pruneOldSeries();
    return quote;
  }

  /** USD/HKD → CNY display rate, refreshed at most every 30 minutes. */
  async function refreshFx() {
    const pair = cfg.market?.fx;
    if (!pair || cfg.currency === 'CNY') return;
    if (fxRate && now() - (fxRate.ts ?? 0) < 30 * 60_000) return;
    const base = String(pair).replace(/CNY$/i, '');
    const rate = await fetchFxRate(fetchFn, base);
    if (Number.isFinite(rate)) {
      fxRate = { rate, ts: now() };
      db.putState(pkey('fx'), fxRate);
    }
  }

  function pruneOldSeries() {
    if (typeof db.pruneSeries !== 'function') return;
    const last = db.getState(pkey('seriesPrunedAt')) ?? 0;
    if (now() - last < 6 * 3600_000) return;
    try {
      db.pruneSeries(3000);
      db.putState(pkey('seriesPrunedAt'), now());
    } catch { /* pruning is best-effort */ }
  }

  /** Session date (wrap-around aware): post-midnight hours belong to the prior session day. */
  function sessionDate(ts = now()) {
    return sessionDateOf(cfg.rules, ts, product.timezone);
  }

  /** Epoch of the session day's start: sessions[0].start on the session date. */
  function sessionStartMs() {
    const [y, m, d] = sessionDate().split('-').map(Number);
    const startMin = cfg.rules?.sessions?.[0]?.[0] ?? 0;
    return zonedEpoch(y, m, d, Math.floor(startMin / 60), startMin % 60, cfg.timezone);
  }

  /**
   * The session's true open: the earliest recorded price at/after the session
   * start. Null when the session has no ticks yet (or hasn't started).
   */
  function sessionOpenPrice(symbol) {
    const dayStart = sessionStartMs();
    if (dayStart > now()) return null; // session hasn't started (cross-midnight case)
    if (product.market.kind === 'single') {
      const ticks = db.latestTicksByProduct(product.id, 5000);
      const first = ticks.find(t => t.ts >= dayStart && Number.isFinite(t.price));
      return first?.price ?? null;
    }
    const rows = db.listPoints(product.id, symbol, 3000);
    const first = rows.find(p => p.ts >= dayStart && Number.isFinite(p.price));
    return first?.price ?? null;
  }

  /**
   * Resolve and persist one symbol's day-open baseline.
   * Trusted records are `{price, at}` objects written while a session was
   * open; legacy plain numbers (recorded at midnight against a closed market)
   * are re-resolved from the first in-session tick.
   */
  function recordDayOpen(prices) {
    const key = pkey(`dayOpen:${sessionDate()}`);
    const map = db.getState(key) ?? {};
    let changed = !db.getState(key);
    for (const [sym, current] of Object.entries(prices)) {
      const rec = map[sym];
      if (rec != null && typeof rec === 'object' && Number.isFinite(rec.price)) continue; // trusted
      const fromHistory = sessionOpenPrice(sym);
      map[sym] = { price: fromHistory ?? (typeof rec === 'number' ? rec : current), at: now() };
      changed = true;
    }
    if (changed) db.putState(key, map);
    return map;
  }

  function seriesFor(symbol, limit = DEFAULT_SERIES) {
    const cutoff = now() - 400 * 86_400_000; // ignore stale/misparsed history rows
    if (product.market.kind === 'single') {
      return db.latestTicksByProduct(product.id, limit).map(t => t.price).filter(Number.isFinite);
    }
    return db.listPoints(product.id, symbol, limit)
      .filter(p => !Number.isFinite(p.ts) || p.ts >= cutoff)
      .map(p => p.price)
      .filter(Number.isFinite);
  }

  /**
   * Signal bars resampled to the strategy's horizon so MA/ROC/RSI have a
   * consistent time meaning (raw ticks made MA20 ≈ 20 minutes, not 20 days):
   *  - '1d': one bar per market-local date (daily history + intraday ticks
   *    merge into the same calendar-day bucket; last price wins).
   *  - '1h': hourly buckets from in-session points only (closed-hours quotes
   *    are static and would flatten volatility and moving averages).
   * Rows arrive ascending, so later points overwrite the bucket close.
   */
  function barsFor(symbol, interval = cfg.strategy?.barInterval ?? '1d', count = 240) {
    const intraday = interval === '1h';
    const cutoff = now() - 400 * 86_400_000;
    // single（黄金）：1h 只读 ticks（种子在 series，结构上进不来）；
    // 1d 合并 series 种子 + 实时 ticks，按 ts 升序，让同日实时价覆盖种子。
    const rows = product.market.kind === 'single'
      ? (intraday
        ? db.latestTicksByProduct(product.id, 5000)
        : [...db.listPoints(product.id, symbol, 5000), ...db.latestTicksByProduct(product.id, 5000)]
          .sort((a, b) => a.ts - b.ts))
      : db.listPoints(product.id, symbol, 5000);
    const buckets = new Map();
    for (const r of rows) {
      if (!Number.isFinite(r.ts) || r.ts < cutoff || !Number.isFinite(r.price)) continue;
      if (intraday && !isSessionOpen(cfg.rules, r.ts, cfg.timezone)) continue;
      const key = intraday ? Math.floor(r.ts / 3_600_000) : zonedParts(r.ts, cfg.timezone).date;
      buckets.set(key, r.price);
    }
    return [...buckets.keys()].sort().slice(-count).map(k => buckets.get(k));
  }

  /** Realized volatility of the signal bars (stdev of returns). */
  function barVolatility(symbol) {
    return volatility(barsFor(symbol), 20);
  }

  function volumesFor(symbol, limit = DEFAULT_SERIES) {
    if (product.market.kind === 'single') return [];
    return db.listPoints(product.id, symbol, limit).map(p => p.volume).filter(Number.isFinite);
  }

  /* ------------------------------ evaluation ------------------------------- */

  function evaluateSymbol(symbol, news = []) {
    const series = barsFor(symbol);
    const signals = evaluateSignals(activeSignals(), {
      series,
      volumes: volumesFor(symbol),
      news,
      // Macro factors are product-level; PE percentile is pool cross-sectional.
      realYield: factors?.realYield ?? null,
      usdIndex: factors?.usdIndex ?? null,
      breakeven: factors?.breakeven ?? null,
      yieldCurve: factors?.yieldCurve ?? null,
      goldSilverRatio: factors?.goldSilverRatio ?? null,
      pePercentile: pePercentileOf(symbol),
      pbPercentile: pbPercentileOf(symbol),
    });
    const score = compositeScore(signals);
    return { symbol, score, signals, price: priceOf(symbol) };
  }

  /** Cross-sectional percentile of `read(symbol)` within the pool
   *  (1 = cheapest in pool). Shared by PE/PB so the two cannot drift apart. */
  function percentileOf(read, symbol) {
    if (product.market.kind === 'single') return null;
    const vals = pool()
      .map(w => read(w.symbol))
      .filter(p => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);
    const own = read(symbol);
    if (!Number.isFinite(own) || own <= 0) return null;
    if (vals.length < 2) return 0.5; // single-name pool → neutral (spec §9)
    const below = vals.filter(x => x < own).length;
    return Math.round((below / (vals.length - 1)) * 100) / 100;
  }

  /** Cross-sectional PE percentile within the pool. */
  const pePercentileOf = (symbol) => percentileOf((sym) => quote?.[sym]?.pe, symbol);

  /** Cross-sectional PB percentile within the pool.
   *  PB 仅 A 股报价解析（parseTencent 的 sh/sz 门），美/港恒 null →
   *  valuation 信号自动回退纯 PE。 */
  const pbPercentileOf = (symbol) => percentileOf((sym) => quote?.[sym]?.pb, symbol);

  /** Candidate threshold: version-evolved > product default > 0.8. */
  function candidateThreshold() {
    const v = Number(current().strategy?.candidates?.threshold);
    if (Number.isFinite(v)) return v;
    const p = Number(cfg.strategy?.candidates?.threshold);
    return Number.isFinite(p) ? p : 0.8;
  }

  function candidates(news) {
    const list = product.market.kind === 'single'
      ? [pool()[0]?.symbol ?? product.id]
      : pool().map(w => w.symbol);
    const scored = list.map(s => evaluateSymbol(s, news));
    return { scored, picked: pickCandidates(scored, { threshold: candidateThreshold(), topN: 5 }) };
  }

  /* ------------------------------- decisions ------------------------------- */

  /** Human-readable macro factor block (spec §5.3) with staleness markers. */
  function factorLines(ctx) {
    const f = ctx.factors ?? {};
    const mark = (x) => (x?.stale ? '【已过期】' : '');
    const fmtDelta = (d, kind) => {
      if (!Number.isFinite(d)) return '—';
      return kind === 'bp'
        ? `${d >= 0 ? '+' : ''}${Math.round(d * 100)}bp`
        : `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
    };
    const ry = f.realYield;
    const usd = f.usdIndex;
    const be = f.breakeven;
    const yc = f.yieldCurve;
    const gsr = f.goldSilverRatio;
    const fmtVal = (v, unit) => (Number.isFinite(v) ? `${v.toFixed(2)}${unit}` : '—');
    return [
      ry
        ? `实际收益率 ${Number.isFinite(ry.value) ? `${ry.value}%` : '—'}（5日 ${fmtDelta(ry.delta5d, 'bp')}，数据截至 ${ry.asOf}）${mark(ry)}`
        : '实际收益率 数据不可用',
      usd
        ? `美元指数 ${Number.isFinite(usd.value) ? usd.value.toFixed(2) : '—'}（5日 ${fmtDelta(usd.delta5d, 'pct')}，数据截至 ${usd.asOf}）${mark(usd)}`
        : '美元指数 数据不可用',
      be
        ? `通胀预期 ${fmtVal(be.value, '%')}（5日 ${fmtDelta(be.delta5d, 'bp')}，数据截至 ${be.asOf}）${mark(be)}`
        : '通胀预期 数据不可用',
      yc
        ? `收益率曲线(10Y−2Y) ${fmtVal(yc.value, 'pp')}（5日 ${fmtDelta(yc.delta5d, 'bp')}，数据截至 ${yc.asOf}）${mark(yc)}`
        : '收益率曲线 数据不可用',
      gsr
        ? `金银比 ${Number.isFinite(gsr.value) ? gsr.value.toFixed(1) : '—'}（5日 ${fmtDelta(gsr.delta5d, 'pct')}，数据截至 ${gsr.asOf}）${mark(gsr)}`
        : '金银比 数据不可用',
    ];
  }

  function buildPrompt(ctx) {
    const p = cfg.strategy.prompt ?? {};
    const symbols = new Set(pool().map(w => w.symbol));
    const newsLines = (ctx.news ?? []).slice(0, 16);
    const perSymbol = newsLines.filter(n => symbols.has(n.source ?? ''));
    const market = newsLines.filter(n => !symbols.has(n.source ?? ''));
    const symbolBlock = [...symbols].map((s) => {
      const items = perSymbol.filter(n => n.source === s).slice(0, 3);
      if (!items.length) return null;
      const name = pool().find(w => w.symbol === s)?.name ?? s;
      return [`### ${name} (${s})`, ...items.map(n => `- ${n.title}`)].join('\n');
    }).filter(Boolean);
    const lines = [
      p.role ?? `你是${cfg.name}投资策略引擎。`,
      '',
      `## 市场（${cfg.name}，${cfg.currency}）`,
      JSON.stringify(ctx.market, null, 2),
      '',
      '## 持仓',
      JSON.stringify(ctx.positions, null, 2),
      '',
      '## 宏观因子',
      ...factorLines(ctx),
      ...(ctx.peTable?.length
        ? ['', '## 个股基本面（PE/PB 与池内分位，分位低=相对便宜）',
          ...ctx.peTable.map(x => `- ${x.name}(${x.symbol}) PE ${x.pe}${x.pb != null ? ` / PB ${x.pb}` : ''}（池内分位 ${x.percentile ?? '—'}）`)]
        : []),
      ...(product.market.kind === 'multi'
        ? ['', '## 每手金额（买入至少一手；超过单笔上限的标的买不了，不要选）',
          ...pool().map((w) => {
            const px = quote?.[w.symbol]?.price;
            if (!Number.isFinite(px)) return null;
            const lot = cfg.rules?.lotSizeFor?.(w.symbol) ?? cfg.rules?.lotSize ?? 1;
            return `- ${w.name}(${w.symbol}) 每手 ${lot} 股 ≈ ${Math.round(lot * px)} ${cfg.currency}`;
          }).filter(Boolean)]
        : []),
      '',
      '## 信号与候选',
      JSON.stringify(ctx.signals, null, 2),
      JSON.stringify(ctx.picked, null, 2),
      '',
      '## 市场资讯',
      market.slice(0, 8).map((n, i) => `${i + 1}. ${n.title}`).join('\n') || '（暂无）',
      '',
      '## 个股资讯（按标的）',
      symbolBlock.join('\n\n') || '（暂无）',
      '',
      `## 规则`,
      ...(p.heuristics ?? []).map(h => `- 经验：${h}`),
      ...(p.constraints ?? []).map(c => `- 约束：${c}`),
      '',
      '只输出 JSON：{"action":"buy|sell|hold","symbol":"...","amount":金额或null,"qty":数量或null,"reason":"...","confidence":0~1,"plan":{...}}',
      '约束：买入的 symbol 必须是下方「候选」中列出的标的，或已有持仓的标的；候选为空时只能 hold。',
      `约束：候选门槛 = 综合分 ≥ ${candidateThreshold()}，低于门槛的标的即使判断便宜也不能买。`,
    ];
    return lines.join('\n');
  }

  /**
   * First parseable JSON object in a model response. A greedy /\{[\s\S]*\}/
   * match breaks on trailing prose or two objects (the observed 4% "无法解析"
   * rate); balanced scanning tolerates both.
   */
  function firstJsonObject(text) {
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] !== '{') continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < s.length; j += 1) {
        const ch = s[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const v = JSON.parse(s.slice(i, j + 1));
              if (v && typeof v === 'object' && !Array.isArray(v)) return v;
            } catch { /* keep scanning */ }
            break;
          }
        }
      }
    }
    return null;
  }

  function parseReflection(raw) {
    const j = firstJsonObject(raw);
    if (!j) return null;
    return {
      critique: String(j.critique ?? ''),
      params: j.params != null && typeof j.params === 'object' ? j.params : {},
    };
  }

  function parseDecision(raw) {
    try {
      const j = firstJsonObject(raw);
      if (!j || typeof j !== 'object') return null;
      const action = ['buy', 'sell', 'hold'].includes(j.action) ? j.action : 'hold';
      const symbol = j.symbol == null || j.symbol === '' ? null : String(j.symbol);
      return {
        action,
        symbol,
        amount: Number.isFinite(j.amount) ? j.amount : null,
        qty: Number.isFinite(j.qty) ? j.qty : null,
        reason: String(j.reason ?? '').slice(0, 500),
        confidence: Number.isFinite(j.confidence) ? j.confidence : 0.5,
        horizonHours: Number.isFinite(j.horizonHours) ? j.horizonHours : null,
        plan: j.plan ?? null,
      };
    } catch {
      return null;
    }
  }

  /* --------------------------------- gates --------------------------------- */

  function tradesToday() {
    const today = sessionDate();
    return db.listTradesByProduct(product.id, 200).filter(t => sessionDate(t.ts) === today);
  }

  function dayOpenPrices() {
    const map = db.getState(pkey(`dayOpen:${sessionDate()}`)) ?? {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = v != null && typeof v === 'object' ? v.price : v; // legacy numbers pass through
    }
    return out;
  }

  function dailyLossHit() {
    const risk = effectiveRisk();
    const snap = snapshotOf(account, priceOf, s => dayOpenPrices()[s] ?? null);
    const base = account.initial || 1;
    return snap.todayPnl / base * 100 <= (risk.dailyLossPct ?? -2);
  }

  function exposureOf() {
    return snapshotOf(account, priceOf).positionsValue;
  }

  function symbolValue(symbol) {
    const pos = account.positions[symbol];
    const price = priceOf(symbol);
    return pos && Number.isFinite(price) ? (pos.qty ?? 0) * price : 0;
  }

  function fillPrice(side, symbol) {
    if (product.market.kind === 'single') {
      return side === 'buy' ? (quote?.buy ?? quote?.price) : (quote?.sell ?? quote?.price);
    }
    return priceOf(symbol);
  }

  function buyQuantity(decision, symbol, price) {
    // Explicit quantity keeps lot discipline; an amount is risk-budgeted:
    // riskPerTradePct of capital ÷ stop distance caps the notional so each
    // trade risks the SAME fraction of capital regardless of stop width.
    if (decision.qty != null && decision.qty > 0) return roundLot(cfg.rules, decision.qty, symbol);
    const risk = effectiveRisk();
    let notional = decision.amount ?? risk.perTrade ?? 0;
    const stopPct = Math.abs(risk.stopLossPct ?? 0);
    const riskPct = risk.riskPerTradePct;
    if (Number.isFinite(riskPct) && stopPct > 0) {
      const budget = (account.initial * riskPct) / (stopPct / 100);
      notional = Math.min(notional, budget);
    }
    let qty = roundLot(cfg.rules, notional / price, symbol);
    // Lumpy lots (e.g. HK 100-share boards): when the budget buys less than
    // one lot, take the smallest position the per-trade cap still allows.
    if (qty <= 0) {
      const oneLot = cfg.rules.unit === 'gram' ? 1 : Math.max(1, Math.floor(cfg.rules.lotSize ?? 1));
      if (oneLot * price <= (risk.perTrade ?? Infinity)) qty = oneLot;
    }
    return qty;
  }

  function execute(decision, picked = null) {
    const symbol = decision.symbol ?? (product.market.kind === 'single' ? (pool()[0]?.symbol ?? product.id) : null);
    if (!symbol) return { ok: false, reason: '缺目标标的' };
    const risk = effectiveRisk();
    const maxAgeSec = risk.quoteMaxAgeSec ?? 300;
    if (now() - quoteTs > maxAgeSec * 1000) return { ok: false, reason: '行情过期，拒绝成交' };
    const price = fillPrice(decision.action, symbol);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: '无有效行情' };

    if (!isSessionOpen(cfg.rules, now(), cfg.timezone)) return { ok: false, reason: '非交易时段' };

    const prevClose = prevCloseOf(symbol);
    // 真实涨跌停（A股报价字段）优先于配置带；美/港报价无此字段 → 配置带。
    const quoteBand = product.market.kind === 'single'
      ? { up: quote?.limitUp, down: quote?.limitDown }
      : { up: quote?.[symbol]?.limitUp, down: quote?.[symbol]?.limitDown };
    if (!withinPriceBand(cfg.rules, prevClose, price, symbol, quoteBand)) return { ok: false, reason: '超出涨跌停价格区间' };

    // Frequency discipline applies to ENTRIES only: risk/LLM sells reduce
    // exposure and must never be blocked by churn controls.
    const plan = { ...(cfg.strategy?.plan ?? {}), ...(current().strategy?.plan ?? {}) };
    const hardMax = cfg.rules?.hardMaxTradesPerDay ?? risk.maxTradesPerDay ?? 3;
    const hardGapH = cfg.rules?.hardMinIntervalHours ?? 0;
    const maxPerDay = Math.min(plan.maxTradesPerDay ?? hardMax, hardMax);
    const minGap = Math.max(plan.minIntervalHours ?? 0, hardGapH) * 3600_000;

    if (decision.action === 'buy') {
      const buysToday = tradesToday().filter(t => t.side === 'buy');
      if (buysToday.length >= maxPerDay) return { ok: false, reason: `已达每日交易上限(${maxPerDay})` };
      const lastBuy = buysToday[0];
      if (lastBuy && now() - lastBuy.ts < minGap) return { ok: false, reason: '未达最小交易间隔' };
      // Rule-engine discipline: an entry must be a current candidate or an
      // existing holding — the LLM arbitrates setups, it cannot invent them.
      if (Array.isArray(picked) && !picked.some(c => c.symbol === symbol) && !positionOf(account, symbol)) {
        return { ok: false, reason: '标的不在候选或持仓中' };
      }
      // Volatility gate: refuse new entries in dead markets (exits pass).
      const minVol = risk.minVolatility;
      if (Number.isFinite(minVol)) {
        const vol = barVolatility(symbol);
        if (vol != null && vol < minVol) {
          return { ok: false, reason: `低波动率过滤(σ ${(vol * 100).toFixed(3)}% < ${(minVol * 100).toFixed(3)}%)` };
        }
      }
      const qty = buyQuantity(decision, symbol, price);
      if (!(qty > 0)) return { ok: false, reason: '数量不足一手' };
      const notional = qty * price;
      if (notional > (risk.perTrade ?? Infinity) + 1e-6) return { ok: false, reason: `超过单笔上限 ${risk.perTrade}` };
      // The strategy plan's position cap bounds total exposure (and therefore
      // each symbol too); the product's capital ceiling still applies on top.
      const planPct = Number.isFinite(plan.maxPositionPct) ? plan.maxPositionPct : 100;
      const planCap = (account.initial * planPct) / 100;
      const perSymbolCap = Math.min((account.initial * (risk.perSymbolPct ?? 100)) / 100, planCap);
      if (symbolValue(symbol) + notional > perSymbolCap + 1e-6) {
        return { ok: false, reason: '超过单标的敞口上限' };
      }
      const totalCap = Math.min(cfg.capital?.maxExposureRmb ?? account.initial, planCap);
      if (exposureOf() + notional > totalCap + 1e-6) {
        return { ok: false, reason: '超过总敞口上限' };
      }
      const fee = tradeFees(cfg.rules, 'buy', notional).total;
      if (notional + fee > account.cash + 1e-9) return { ok: false, reason: '现金不足' };
      applyBuy(account, { symbol, qty, price, fee, ts: now(), earliestSellTs: earliestSellTs(now(), cfg.rules, cfg.timezone) });
      // A fresh lot re-arms the take-profit trim for this position.
      account.positions[symbol].tpTaken = false;
      db.insertTrade({ ts: now(), side: 'buy', grams: cfg.rules.unit === 'gram' ? qty : 0, price, rmb: notional, note: decision.reason, product: product.id, symbol, name: poolNames().get(symbol) ?? '' });
      // Buy-and-hold benchmark: seeded at the first fill so the strategy is
      // always judged against simply holding from the same entry.
      if (!db.getState(pkey('benchmark'))) {
        db.putState(pkey('benchmark'), { symbol, price, ts: now() });
      }
      return { ok: true, side: 'buy', symbol, name: poolNames().get(symbol) ?? '', qty, price, fee, notional, reason: decision.reason };
    }

    if (decision.action === 'sell') {
      const pos = positionOf(account, symbol);
      if (!pos) return { ok: false, reason: '无持仓可卖' };
      const qty = decision.qty != null ? Math.min(decision.qty, pos.qty) : pos.qty;
      const sellQty = cfg.rules.unit === 'gram' ? qty : roundLot(cfg.rules, qty, symbol);
      if (!(sellQty > 0)) return { ok: false, reason: '卖出数量为0' };
      const notional = sellQty * price;
      const fee = tradeFees(cfg.rules, 'sell', notional).total;
      try {
        const r = applySell(account, { symbol, qty: sellQty, price, fee, ts: now() });
        db.insertTrade({ ts: now(), side: 'sell', grams: cfg.rules.unit === 'gram' ? sellQty : 0, price, rmb: notional, note: decision.reason, product: product.id, symbol, name: poolNames().get(symbol) ?? '', realized: r.realized });
        return { ok: true, side: 'sell', symbol, name: poolNames().get(symbol) ?? '', qty: sellQty, price, fee, notional, realized: r.realized, reason: decision.reason };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    }
    return { ok: false, reason: 'hold' };
  }

  function riskCheck() {
    const risk = effectiveRisk();
    // A configured hard floor can only TIGHTEN a version's stop, never loosen
    // it: -5 keeps a version that evolved to -12 from risking 12% per trade.
    const hard = Number.isFinite(risk.hardStopLossPct) ? risk.hardStopLossPct : -Infinity;
    const stop = Number.isFinite(risk.stopLossPct) ? Math.max(risk.stopLossPct, hard) : risk.stopLossPct;
    const take = risk.takeProfitPct;
    const trail = risk.trailingStopPct;
    const maxHoldMs = Number.isFinite(risk.maxHoldHours) ? risk.maxHoldHours * 3600_000 : null;
    for (const symbol of Object.keys(account.positions)) {
      const p = account.positions[symbol];
      const price = priceOf(symbol);
      if (!Number.isFinite(price) || !(p.costAvg > 0)) continue;
      const pct = ((price - p.costAvg) / p.costAvg) * 100;
      if (Number.isFinite(stop) && pct <= stop) return { kind: 'stop-loss', symbol, pct };
      // Take-profit trims once per position (tpTaken) when a fraction is set;
      // otherwise it liquidates the whole position.
      if (Number.isFinite(take) && pct >= take && !p.tpTaken) {
        return { kind: 'take-profit', symbol, pct, fraction: Number(risk.takeProfitFraction) };
      }
      // Trailing stop: once in profit, lock gains by exiting when price falls
      // trailingStopPct from the highest price seen since entry.
      if (Number.isFinite(trail) && pct >= 0) {
        p.peakPrice = Math.max(p.peakPrice ?? price, price);
        const fromPeak = ((price - p.peakPrice) / p.peakPrice) * 100;
        if (fromPeak <= -trail) return { kind: 'trailing-stop', symbol, pct, fromPeak };
      }
      // Time stop: a losing position held beyond maxHoldHours is dead money.
      if (maxHoldMs != null && pct <= 0) {
        const oldest = (p.lots ?? []).reduce((a, l) => Math.min(a, l.ts ?? Infinity), Infinity);
        if (Number.isFinite(oldest) && now() - oldest >= maxHoldMs) {
          const heldH = Math.round((now() - oldest) / 3600_000);
          return { kind: 'time-stop', symbol, pct, heldH };
        }
      }
    }
    return { kind: 'none' };
  }

  /* -------------------------------- cycle ---------------------------------- */

  let running = false;

  async function runCycle() {
    if (running) return jsonSafe({ busy: true, decision: { action: 'hold', reason: '上一轮分析仍在进行' }, trades: [], llmError: null, paused, quoteTs });
    running = true;
    try {
      return await runCycleInner();
    } finally {
      running = false;
    }
  }

  async function runCycleInner() {
    // Refresh quotes every cycle: gates and risk checks must see current prices.
    await tick().catch(() => {});
    // Every early return carries quoteTs: the scheduler's health predicate
    // (assessCycle) needs it to tell an environment failure from a
    // deliberate hold (breaker/paused/busy).
    if (!quote) return jsonSafe({ decision: { action: 'hold', reason: 'no quote' }, trades: [], llmError: null, paused, quoteTs });
    if (paused) return jsonSafe({ decision: { action: 'hold', reason: 'paused' }, trades: [], llmError: null, paused: true, quoteTs });
    // Session gate: an LLM call while the market is closed can only end in a
    // rejected order (the old "非交易时段" rejections), so skip the whole cycle
    // — no LLM cost, no journal entry, and health metrics then describe
    // actionable cycles only. Quotes were already refreshed by tick().
    if (!isSessionOpen(cfg.rules, now(), product.timezone)) {
      const decision = { action: 'hold', reason: '休市：跳过本轮决策', confidence: 0 };
      lastRun = { decision, trades: [], rejection: null, llmError: null, closedSession: true };
      return jsonSafe({ decision, trades: [], rejection: null, llmError: null, paused, closedSession: true, quoteTs });
    }
    // Total-drawdown circuit breaker: stop opening new trades once the account
    // is down by the configured percentage from its starting capital.
    const snap0 = snapshotOf(account, priceOf, s => dayOpenPrices()[s] ?? null);
    const drawdownPct = ((snap0.totalPnl) / (account.initial || 1)) * 100;
    const breakerPct = effectiveRisk().circuitBreakerPct;
    if (Number.isFinite(breakerPct) && drawdownPct <= breakerPct) {
      const decision = { action: 'hold', reason: `总回撤熔断(${drawdownPct.toFixed(2)}%)，暂停新交易`, confidence: 0 };
      lastRun = { decision, trades: [], rejection: null, llmError: null };
      return jsonSafe({ decision, trades: [], rejection: null, llmError: null, paused, circuitBreaker: true, ingest: lastIngest, quoteTs });
    }
    if (newsIngest) {
      try {
        // The poll timer owns freshness; the decision cycle only refreshes
        // when the last ingest is already older than the poll interval
        // (lastIngest is null on boot → the boot ingest still runs).
        if (!lastIngest?.ts || now() - lastIngest.ts >= newsPollMin * 60_000) {
          lastIngest = await newsIngest();
        }
      } catch { /* news is best-effort */ }
    }
    // Macro factors refresh in the BACKGROUND: a slow/unreachable source must
    // never delay a decision cycle (signals simply abstain until data lands).
    // Give the (usually fast) fetch a bounded 3s window before the prompt is
    // built so the first cycle after boot/refresh also sees factor data;
    // the promise keeps filling the cache either way.
    const factorPromise = collectFactors(fetchFn, db, now)
      .then((f) => { factors = f; })
      .catch(() => { /* keep the previous snapshot */ });
    let factorTimer;
    await Promise.race([
      factorPromise,
      new Promise((resolve) => { factorTimer = setTimeout(resolve, 3000); }),
    ]).finally(() => clearTimeout(factorTimer));
    const news = (newsList?.() ?? []);

    const risk = riskCheck();
    let decision = null;
    let llmError = null;
    let rejection = null;
    let trades = [];
    let pickedForExec = null;   // candidates the entry must belong to (B3)
    let signalsSnapshot = null; // what the model saw, journaled for review (C3)
    let tpSymbol = null;        // take-profit trim to mark once the sell fills

    if (risk.kind !== 'none') {
      // A configured take-profit fraction trims the position once; anything
      // else (stop/trailing/time) liquidates.
      let qty = null;
      const pos = positionOf(account, risk.symbol);
      const frac = Number(risk.fraction);
      if (risk.kind === 'take-profit' && pos && Number.isFinite(frac) && frac > 0 && frac < 1) {
        const part = roundLot(cfg.rules, pos.qty * frac, risk.symbol);
        if (part > 0 && part < pos.qty) qty = part;
      }
      decision = { action: 'sell', symbol: risk.symbol, qty, reason: `风控触发：${risk.kind} ${risk.pct.toFixed(2)}%`, confidence: 1 };
      if (risk.kind === 'take-profit' && pos?.tpTaken !== true) tpSymbol = risk.symbol;
    } else {
      const { scored, picked } = candidates(news);
      pickedForExec = picked;
      signalsSnapshot = scored.map(s => ({
        symbol: s.symbol,
        score: s.score,
        // Keep note/noData: health coverage counts "数据不足" abstentions, and
        // the health prompt must see WHY a signal scored 0.
        signals: (s.signals ?? []).map(x => ({
          id: x.id,
          score: x.score,
          ...(x.note ? { note: x.note } : {}),
          ...(x.noData ? { noData: true } : {}),
        })),
      }));
      const ctx = {
        market: { price: quote, ts: quoteTs, currency: cfg.currency },
        positions: snapshotOf(account, priceOf).positions,
        signals: scored,
        picked,
        news,
        factors,
        peTable: product.market.kind === 'multi'
          ? pool().map(w => ({
            symbol: w.symbol,
            name: w.name,
            pe: quote?.[w.symbol]?.pe ?? null,
            pb: quote?.[w.symbol]?.pb ?? null,
            percentile: pePercentileOf(w.symbol),
          })).filter(x => Number.isFinite(x.pe))
          : [],
      };
      let raw = null;
      try {
        raw = await llm(buildPrompt(ctx));
        decision = parseDecision(raw);
      } catch (e) {
        llmError = String(e?.message ?? e).slice(0, 300);
      }
      // Surface silent parse failures (previously looked like a clean hold).
      if (!decision && raw != null && !llmError) llmError = 'LLM 输出无法解析，已回退 hold';
      if (!decision) decision = { action: 'hold', reason: 'fallback hold', confidence: 0 };
      if (decision.action !== 'hold' && (decision.confidence ?? 0) < (effectiveRisk().minConfidence ?? 0.55)) {
        decision = { action: 'hold', reason: `置信度不足(${decision.confidence})`, confidence: decision.confidence };
      }
      if (dailyLossHit() && decision.action !== 'hold') {
        decision = { action: 'hold', reason: '单日亏损达到上限，暂停交易', confidence: decision.confidence };
      }
    }

    if (decision.action !== 'hold') {
      const r = execute(decision, pickedForExec);
      if (r.ok) {
        trades = [r];
        if (tpSymbol) {
          const p = positionOf(account, tpSymbol);
          if (p) p.tpTaken = true;
        }
      } else rejection = r.reason;
    }
    if (lastIngest) lastIngest = { ...lastIngest };
    lastRun = { decision, trades, rejection, llmError };
    // Persist decisions so reflection after a restart still sees what was done,
    // including the signal scores the model based its choice on (C3).
    const journal = db.getState(pkey('decisions')) ?? [];
    journal.push({
      ts: now(), decision, trades, rejection, llmError,
      signals: signalsSnapshot,
      picked: (pickedForExec ?? []).map(p => p.symbol),
    });
    db.putState(pkey('decisions'), journal.slice(-50));
    persist();
    return jsonSafe({ decision, trades, rejection, llmError, paused, quoteTs, ingest: lastIngest });
  }

  /* -------------------------------- status --------------------------------- */

  /** Buy-and-hold benchmark view: first-fill price vs the current price. */
  function benchmarkView() {
    const b = db.getState(pkey('benchmark'));
    if (!b || !Number.isFinite(b.price) || b.price <= 0) return null;
    const price = priceOf(b.symbol);
    const returnPct = Number.isFinite(price) ? ((price - b.price) / b.price) * 100 : null;
    return {
      symbol: b.symbol,
      price: b.price,
      ts: b.ts,
      returnPct: returnPct == null ? null : Math.round(returnPct * 100) / 100,
    };
  }

  function status(symbol) {
    const snap = snapshotOf(account, priceOf, s => dayOpenPrices()[s] ?? null);
    // Chart target: an explicit symbol from the pool, else the pool's first.
    const poolList = pool();
    const watchSymbol = (symbol && poolList.some(w => w.symbol === symbol))
      ? symbol
      : (poolList[0]?.symbol ?? product.id);
    // Chart window: collapse frozen out-of-session runs (post-close polls
    // repeated the same price hundreds of times — the "straight line" bug)
    // while keeping every in-session point, the official close, and daily
    // seed bars (their midnight timestamps are out-of-session but change
    // price, so they survive the dedup).
    const series = (() => {
      const rows = product.market.kind === 'single'
        ? db.latestTicksByProduct(product.id, 1500)
        : db.listPoints(product.id, watchSymbol, 1500);
      const kept = [];
      let prevPrice = null;
      for (const r of rows) {
        const inS = isSessionOpen(cfg.rules, r.ts, cfg.timezone);
        if (inS || prevPrice === null || r.price !== prevPrice) kept.push(r);
        prevPrice = r.price;
      }
      return kept.slice(-120).map(r => ({ ts: r.ts, price: r.price }));
    })();
    return jsonSafe({
      product: { id: cfg.id, name: cfg.name, currency: cfg.currency, unit: cfg.rules?.unit ?? 'share', kind: cfg.market?.kind ?? 'multi', order: cfg.order },
      quote,
      quoteTs,
      paused,
      tradingNow: isSessionOpen(cfg.rules, now(), cfg.timezone),
      snapshot: snap,
      versions,
      currentVersion: current(),
      trades: db.listTradesByProduct(product.id, 20),
      news: typeof newsList === 'function' ? newsList(24) : [],
      reflections: db.getState(pkey('reflections')) ?? [],
      series,
      chartSymbol: watchSymbol,
      benchmark: benchmarkView(),
      factors: readFactors(db), // fresh from the shared cache (all products see it)
      health: healthStats(),
      watchlist: pool(),
      fx: cfg.currency === 'CNY' ? null : fxRate,
      ingest: lastIngest,
      search: lastSearch,
      llm: typeof llmInfo === 'function' ? llmInfo() : null,
    });
  }

  /* ------------------------------- reflection ------------------------------ */

  function versionStats() {
    const snap = snapshotOf(account, priceOf);
    const start = current().startPnl ?? 0;
    const trades = db.listTradesByProduct(product.id, 5000)
      .filter(t => t.ts >= (current().createdAt ?? 0));
    const closes = trades.filter(t => t.side === 'sell');
    const realized = closes.map(t => Number(t.realized)).filter(Number.isFinite);
    const wins = realized.filter(r => r > 0).length;
    // Trailing consecutive losing closes (most recent first).
    let consecLosses = 0;
    for (const r of realized) { if (r < 0) consecLosses += 1; else break; }
    // Max drawdown of the realized P&L curve (approximation: closed trades only).
    let peak = 0;
    let equity = 0;
    let maxDrawdown = 0;
    for (const r of realized) {
      equity += r;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.min(maxDrawdown, equity - peak);
    }
    return {
      returnPnl: Math.round((snap.totalPnl - start) * 100) / 100,
      returnPct: Math.round(((snap.totalPnl - start) / (account.initial || 1)) * 10000) / 100,
      fills: trades.length,
      closes: closes.length,
      wins,
      winRate: realized.length ? Math.round((wins / realized.length) * 1000) / 1000 : null,
      realizedPnl: Math.round(realized.reduce((a, b) => a + b, 0) * 100) / 100,
      consecLosses,
      maxDrawdownPnl: Math.round(maxDrawdown * 100) / 100,
      maxDrawdownPct: Math.round((maxDrawdown / (account.initial || 1)) * 10000) / 100,
      holdingPnl: Math.round(snap.holdingPnl * 100) / 100,
      positions: snap.positions.length,
      benchmarkReturnPct: benchmarkView()?.returnPct ?? null,
    };
  }

  /**
   * 运行健康指标（批次 F）：绩效 stats只回答“赚没赚”，这里回答“为什么没动”——
   * 候选率、各闸门拦截分布、信号数据覆盖率、bar 数 vs 指标所需、LLM 错误率。
   * 数据全部来自已有的决策日志，零额外成本。
   */
  function healthStats(windowSize = 50) {
    const journal = db.getState(pkey('decisions')) ?? [];
    const recent = journal.slice(-windowSize);
    const bars = pool().map(w => ({ symbol: w.symbol, bars: barsFor(w.symbol).length }));
    // The tightest lookback any active signal needs (slow/period + warmup).
    const barsRequired = activeSignals().reduce((m, s) => {
      const p = s.params ?? {};
      return Math.max(m, (p.slow ?? 0) + 2, (p.period ?? 0) + 2);
    }, 0);
    const n = recent.length;
    if (!n) return { cycles: 0, bars, barsRequired };
    const withCandidates = recent.filter(d => (d.picked ?? []).length > 0).length;
    const rejections = {};
    for (const d of recent) {
      if (d.rejection) rejections[d.rejection] = (rejections[d.rejection] ?? 0) + 1;
    }
    let evaluated = 0;
    let covered = 0;
    for (const d of recent) {
      for (const sym of d.signals ?? []) {
        for (const x of sym.signals ?? []) {
          evaluated += 1;
          if (!x.noData && x.note !== '数据不足') covered += 1;
        }
      }
    }
    const llmErrors = recent.filter(d => d.llmError).length;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return {
      cycles: n,
      candidateRate: r3(withCandidates / n),
      rejections,
      signalCoverage: evaluated ? r3(covered / evaluated) : null,
      bars,
      barsRequired,
      llmErrorRate: r3(llmErrors / n),
    };
  }

  /** Health reflection fires when the system is alive but produces nothing. */
  function healthTriggered(h) {
    if (!h || h.cycles < 20) return false;
    if (h.candidateRate < 0.05) return true; // effectively zero candidates
    if (h.signalCoverage != null && h.signalCoverage < 0.3) return true; // severe data starvation
    return false;
  }

  /** Only signal lookback params, shrink-only, qualify for the bootstrap fix. */
  const SHRINK_PATH = /^signals\.[^.]+\.params\.(fast|slow|period)$/;

  /**
   * Lookback params that can still be shortened. When every one of them sits
   * at its floor there is no legal shrink fix left, so the health trigger must
   * not spend an LLM call re-proposing values that will be rejected (the old
   * loop did exactly that every 6h). Periodic reflection still reviews daily.
   */
  function shrinkableLookbacks() {
    return (cfg.strategy.evolvable ?? []).filter((w) => {
      if (!SHRINK_PATH.test(w.path)) return false;
      const cur = Number(getPath(current().strategy, w.path));
      return Number.isFinite(cur) && (!Number.isFinite(w.min) || cur > w.min);
    });
  }
  /**
   * Apply shrink-only lookback fixes for a health reflection: bounds + step
   * alignment are enforced, but the performance jump-guard is not — direction
   * is already validated (new < current), and a shorter lookback can never
   * loosen a risk control. This is the bootstrap escape from the sample floor.
   * Off-grid proposals SNAP DOWN to the step grid (23 with step5 → 20):
   * rejecting them outright silently discarded valid shrink fixes (audit C1).
   */
  function applyShrinkOnly(nextStrategy, params, rejected = []) {
    const applied = {};
    const evolvable = cfg.strategy.evolvable ?? [];
    for (const [path, value] of Object.entries(params ?? {})) {
      if (!SHRINK_PATH.test(path)) { rejected.push({ path, reason: 'not-shrink-path' }); continue; }
      const w = evolvable.find(x => x.path === path);
      if (!w) { rejected.push({ path, reason: 'not-evolvable' }); continue; }
      const v = Number(value);
      const cur = getPath(current().strategy, path);
      if (!Number.isFinite(v) || !Number.isFinite(cur)) { rejected.push({ path, reason: 'bad-value' }); continue; }
      const step = w.step ?? 0;
      const snapped = step > 0 && Number.isFinite(w.min)
        ? w.min + Math.floor((v - w.min) / step) * step
        : v;
      if (!Number.isFinite(snapped)) { rejected.push({ path, reason: 'bad-value' }); continue; }
      if (!(snapped < cur)) { rejected.push({ path, reason: 'not-smaller' }); continue; }
      if (Number.isFinite(w.min) && snapped < w.min) { rejected.push({ path, reason: 'below-min' }); continue; }
      if (Number.isFinite(w.max) && snapped > w.max) { rejected.push({ path, reason: 'above-max' }); continue; }
      if (setPath(nextStrategy, path, snapped)) applied[path] = snapped;
      else rejected.push({ path, reason: 'set-failed' });
    }
    return applied;
  }

  function buildHealthPrompt(health) {
    const journal = db.getState(pkey('decisions')) ?? [];
    const last = journal.at(-1);
    const lastEntry = last
      ? { decision: last.decision, rejection: last.rejection, picked: last.picked, signals: last.signals }
      : {};
    return [
      `你是${cfg.name}策略的运行诊断引擎。系统长期零成交，请诊断「为什么没有产生交易」并给出改进。`,
      '',
      '## 运行健康指标',
      JSON.stringify(health, null, 2),
      '',
      '## 当前参数',
      JSON.stringify(current().strategy, null, 2),
      '',
      '## 最近一轮决策（含信号评分）',
      JSON.stringify(lastEntry, null, 2),
      '',
      '## 规则',
      '- 只能输出「信号回看参数」的调整（fast/slow/period），且只能调小——缩短回看以适配现有数据量；调大或改其它参数一律无效',
      '- 路径必须逐字照抄下表（`signals.<信号id>.params.<参数>`），不要另写格式，否则会被丢弃',
      '## 可缩短的回看参数',
      ...shrinkableLookbacks().map(w => `- ${w.path}：当前 ${getPath(current().strategy, w.path)}，下界 ${w.min}，步长 ${w.step ?? 1}`),
      '',
      '## 说明',
      `- 候选 = 综合分 ≥ candidates.threshold（当前 ${candidateThreshold()}，策略版本可演进，但不属于本轮可调参数）；综合分为负时本来就不会有候选，这是设计而非故障。`,
      '- 成交还会被交易时段、最小交易间隔、波动率、手数、单笔/单标的/总敞口等闸门过滤；这些拒绝不等于候选生成失败。',
      '- 若上表已无可缩短参数，说明是结构/数据问题，不要给 params，把结论写进 critique。',
      '- 若问题不在参数（如交易时段、候选阈值、数据源缺失），写在 critique 里说明，不要给 params',
      '',
      '只输出 JSON：{"critique":"...","params":{"路径":数值}}',
    ].join('\n');
  }

  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      // `signals.<signalId>...` addresses the array entry by id, not by index.
      if (Array.isArray(cur) && !/^\d+$/.test(k)) {
        const idx = cur.findIndex(x => x?.id === k);
        if (idx < 0) return false;
        cur = cur[idx];
      } else {
        if (cur[k] == null || typeof cur[k] !== 'object') return false;
        cur = cur[k];
      }
    }
    const leaf = parts[parts.length - 1];
    if (!(leaf in cur)) return false;
    cur[leaf] = value;
    return true;
  }

  /** Read a nested path (array entries by signal id). */
  function getPath(obj, path) {
    const parts = String(path).split('.');
    let cur = obj;
    for (const k of parts) {
      if (cur == null) return undefined;
      if (Array.isArray(cur) && !/^\d+$/.test(k)) {
        const idx = cur.findIndex(x => x?.id === k);
        if (idx < 0) return undefined;
        cur = cur[idx];
      } else {
        cur = cur[k];
      }
    }
    return cur;
  }

  /** Apply only whitelisted, bounded parameter changes; returns applied patches. */
  function applyParams(target, params, rejected = []) {
    const whitelist = cfg.strategy.evolvable ?? [];
    const applied = {};
    let changes = 0;
    for (const [path, raw] of Object.entries(params ?? {})) {
      if (changes >= 3) { rejected.push({ path, reason: 'cap-3' }); break; } // anti-overfit: ≤3 params per review
      const spec = whitelist.find(w => w.path === path);
      if (!spec) { rejected.push({ path, reason: 'not-evolvable' }); continue; }
      let value = Number(raw);
      if (!Number.isFinite(value)) { rejected.push({ path, reason: 'bad-value' }); continue; }
      if (Number.isFinite(spec.min)) value = Math.max(spec.min, value);
      if (Number.isFinite(spec.max)) value = Math.min(spec.max, value);
      if (Number.isFinite(spec.step) && spec.step > 0) {
        const base = Number.isFinite(spec.min) ? spec.min : 0;
        value = base + Math.round((value - base) / spec.step) * spec.step;
      }
      const currentValue = Number(getPath(target, path));
      if (Number.isFinite(currentValue)) {
        // Anti-overfit: at most 20% change per review, but never less than two
        // discrete steps (otherwise a coarse step size freezes the parameter).
        const allowed = Math.max(Math.abs(currentValue) * 0.2, 2 * (Number(spec.step) || 0));
        if (Math.abs(value - currentValue) > allowed + 1e-9) { rejected.push({ path, reason: 'jump-guard' }); continue; }
        // Rounding can land on the current value — that is a no-op, not a
        // version-worthy change (audit M7: 5→5 was recorded as applied).
        if (Math.abs(value - currentValue) <= 1e-9) { rejected.push({ path, reason: 'no-change' }); continue; }
      }
      if (setPath(target, path, value)) {
        applied[path] = value;
        changes += 1;
      } else {
        rejected.push({ path, reason: 'set-failed' });
      }
    }
    return applied;
  }

  function buildReflectPrompt(stats) {
    const journal = db.getState(pkey('decisions')) ?? [];
    const last = journal.at(-1);
    const lastEntry = last
      ? { decision: last.decision, rejection: last.rejection, picked: last.picked, signals: last.signals }
      : { decision: lastRun?.decision ?? null };
    return [
      `你是${cfg.name}策略复盘引擎。请检讨当前策略版本的表现并给出改进。`,
      '',
      '## 当前参数',
      JSON.stringify(current().strategy, null, 2),
      '',
      '## 版本表现',
      JSON.stringify(stats, null, 2),
      '',
      '## 最近决策（含当时的信号评分）',
      JSON.stringify(lastEntry, null, 2),
      '',
      '## 可调整参数（只能改这些路径，且受上下界约束）',
      ...(cfg.strategy.evolvable ?? []).map(w => `- ${w.path} ∈ [${w.min}, ${w.max}] step ${w.step}（当前 ${getPath(current().strategy, w.path)}）`),
      '',
      `候选门槛 candidates.threshold = ${candidateThreshold()}：综合分低于它的标的不进入候选。`,
      '',
      '只输出 JSON：{"critique":"...","params":{"路径":数值}}',
    ].join('\n');
  }

  async function reflectIfDue({ force = false } = {}) {
    const stats = versionStats();
    const health = healthStats();
    const risk = effectiveRisk();
    const lossTriggered = stats.returnPct <= (risk.reflectLossPct ?? -3)
      || (Number.isFinite(risk.reflectConsecLosses) && stats.consecLosses >= risk.reflectConsecLosses)
      || (Number.isFinite(risk.reflectMaxDrawdownPct) && stats.maxDrawdownPct <= risk.reflectMaxDrawdownPct);
    const intervalMs = (cfg.reflectIntervalHours ?? 24) * 3600_000;
    const periodicDue = now() - lastReflectAt >= intervalMs;
    // Health trigger: alive but producing nothing (independent clock, 6h cool-down).
    // Only fire when a legal shrink fix still exists — otherwise the call can
    // only produce rejected params (and burns a call every 6h).
    const healthLast = db.getState(pkey('lastHealthReflectAt')) ?? 0;
    const healthDue = shrinkableLookbacks().length > 0
      && healthTriggered(health)
      && now() - healthLast >= 6 * 3600_000;
    if (!force && !lossTriggered && !periodicDue && !healthDue) {
      return jsonSafe({ reflected: false, stats, health });
    }
    const trigger = force ? 'manual' : lossTriggered ? 'loss' : healthDue ? 'health' : 'periodic';
    let parsed = null;
    let raw = null;
    let llmThrew = false;
    let failDetail = null;
    try {
      const prompt = trigger === 'health' ? buildHealthPrompt(health) : buildReflectPrompt(stats);
      raw = await llm(prompt);
      parsed = parseReflection(raw);
    } catch (e) {
      llmThrew = true;
      failDetail = String(e?.message ?? e).slice(0, 160); // R3: keep the cause
    }
    const critique = String(parsed?.critique ?? '').slice(0, 800) || null;
    const params = parsed?.params ?? {};

    const next = newVersion(versions.length + 1, cfg, now());
    // Keep every untouched field of the current strategy (e.g. plan) and only
    // patch the whitelisted parameters on top.
    next.strategy = JSON.parse(JSON.stringify(current().strategy ?? {}));
    if (!Array.isArray(next.strategy.signals) || next.strategy.signals.length === 0) {
      next.strategy.signals = (cfg.strategy.signals ?? []).map(s => ({ ...s, params: { ...(s.params ?? {}) } }));
    }
    if (!next.strategy.risk || Object.keys(next.strategy.risk).length === 0) {
      next.strategy.risk = { ...(cfg.risk ?? {}) };
    }
    // Anti-overfit: tuning needs a real trade sample. Below the floor only the
    // critique is recorded — EXCEPT a health-triggered reflection may apply
    // shrink-only lookback fixes (shorter lookback cannot loosen any risk).
    const canEvolve = stats.fills >= (effectiveRisk().minSamplesToEvolve ?? 5);
    const rejected = [];
    const applied = canEvolve
      ? applyParams(next.strategy, params, rejected)
      : trigger === 'health'
        ? applyShrinkOnly(next.strategy, params, rejected)
        : (Object.keys(params).length ? (rejected.push({ path: '*', reason: 'sample-floor' }), {}) : {});
    const changed = Object.keys(applied).length > 0;
    const llmOk = parsed != null; // thrown/failed LLM must not consume the cool-down
    // No junk version forks when the LLM failed: a failed loss-triggered
    // reflection retries next cycle instead of cloning the version each time.
    const willFork = (changed || lossTriggered) && llmOk;
    const entry = {
      ts: now(), trigger, stats, health, critique, applied,
      versionCreated: willFork, llmFailed: !llmOk,
      // Raw proposal + per-path rejection reasons: distinguishes "the model
      // proposed nothing" from "everything was filtered out" (audit C2).
      ...(Object.keys(params).length ? { params } : {}),
      ...(rejected.length ? { rejected } : {}),
      // Why it failed: a thrown call (network) vs prose we could not parse —
      // plus the error message / raw snippet so failures are diagnosable.
      ...(llmOk ? {} : {
        failReason: llmThrew ? 'llm-error' : 'unparseable',
        ...(llmThrew ? { failDetail } : { rawSnippet: String(raw ?? '').slice(0, 160) }),
      }),
    };
    const journal = db.getState(pkey('reflections')) ?? [];
    const prev = journal[journal.length - 1];
    if (!llmOk && prev?.llmFailed) {
      // Consecutive failures collapse into one rolling marker: a long outage
      // must not evict real history from the 100-entry journal.
      journal[journal.length - 1] = entry;
    } else {
      journal.push(entry);
    }
    db.putState(pkey('reflections'), journal.slice(-100));
    // Advance the cool-down clocks ONLY on a parseable LLM response — a
    // network outage would otherwise burn the whole 24h/6h window on one
    // failed call and postpone the next real reflection until tomorrow.
    if (llmOk) {
      lastReflectAt = now();
      if (trigger === 'health') db.putState(pkey('lastHealthReflectAt'), now());
    }

    if (willFork) {
      next.startPnl = snapshotOf(account, priceOf).totalPnl;
      next.critique = critique; // remember WHY this version exists (paged per-version)
      versions.push(next);
      persist();
      return jsonSafe({ reflected: true, stats, critique, applied, version: next, versionCreated: true });
    }
    persist();
    return jsonSafe({ reflected: true, stats, critique, applied, versionCreated: false });
  }

  async function ingestNews() {
    if (typeof newsIngest !== 'function') return null;
    lastIngest = await newsIngest();
    return lastIngest;
  }

  /** Product web-search on its own slow timer (searchPollMin). */
  async function searchNews() {
    if (typeof newsSearch !== 'function') return null;
    try {
      lastSearch = await newsSearch();
    } catch (e) {
      lastSearch = { ts: now(), searched: 0, searchError: String(e?.message ?? e).slice(0, 120) };
    }
    return lastSearch;
  }

  /** Publish-date backfill on its own 6h timer, off the decision path. */
  async function backfillDates() {
    if (typeof newsBackfill !== 'function') return null;
    try {
      return await newsBackfill();
    } catch {
      return null;
    }
  }

  /** Offline check: replay the current signals over the product's signal bars. */
  function runBacktestFor(symbol) {
    const sym = symbol ?? pool()[0]?.symbol ?? product.id;
    const risk = effectiveRisk();
    const result = runBacktestCore({
      bars: barsFor(sym),
      signals: activeSignals(),
      threshold: candidateThreshold(),
      stopLossPct: risk.stopLossPct ?? -5,
      takeProfitPct: risk.takeProfitPct ?? 10,
    });
    return jsonSafe({
      symbol: sym,
      barInterval: cfg.strategy?.barInterval ?? '1d',
      version: current().id,
      ...result,
    });
  }

  /** Editable watchlist: add/remove/reset one product's pool. */
  function watchlistAction({ action, symbol, name } = {}) {
    const res = action === 'remove'
      ? removeFromWatchlist(db, product, symbol)
      : action === 'reset'
        ? resetWatchlist(db, product)
        : addToWatchlist(db, product, symbol, name);
    return jsonSafe(res);
  }

  return {
    id: cfg.id,
    product: cfg,
    tick,
    runCycle,
    reflectIfDue,
    status,
    ingestNews,
    searchNews,
    backfillDates,
    watchlist: () => pool(),
    watchlistAction,
    runBacktest: (symbol) => runBacktestFor(symbol),
    listNews: (limit) => (typeof newsList === 'function' ? newsList(limit) : []),
    /** Signal bars for tests/backtest: resampled to the product's horizon. */
    signalBars: (symbol, interval) => barsFor(symbol, interval),
    get quote() { return quote; },
    get account() { return account; },
    snapshot: () => snapshotOf(account, priceOf, s => dayOpenPrices()[s] ?? null),
    pause: (v) => { paused = v === undefined ? !paused : !!v; persist(); return paused; },
    get paused() { return paused; },
  };
}
