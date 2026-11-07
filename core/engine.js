/**
 * 通用产品引擎：一个产品 = 一个账户 + 一套规则。
 * 流程：行情 → 指标/信号 → 候选 → 资讯 → LLM 决策 → 风控闸门 → 模拟成交 → 版本绩效。
 * 引擎不含任何产品专有常量，全部来自产品契约。
 */
import { createAccount, applyBuy, applySell, snapshotOf, positionOf } from './account.js';
import { evaluateSignals, compositeScore, pickCandidates } from './signals.js';
import { isSessionOpen, roundLot, tradeFees, earliestSellTs, withinPriceBand } from './market-rules.js';
import { zonedParts } from './market-rules.js';
import { jsonSafe } from '../lib/json.js';
import { fetchDailyHistory, fetchMinuteHistory } from './quotes.js';

const DEFAULT_SERIES = 240;

export function createProductEngine({
  db, product, llm, fetchFn, now = () => Date.now(), searchFn = undefined,
  newsIngest = null, newsList = null, llmInfo = null,
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
  let lastRun = null;
  let lastReflectAt = db.getState(pkey('lastReflectAt')) ?? now();

  const current = () => versions[versions.length - 1];
  const persist = () => {
    db.putState(pkey('account'), account);
    db.putState(pkey('versions'), versions.map(v => ({ ...v, strategy: stripFns(v.strategy) })));
    db.putState(pkey('paused'), paused);
    db.putState(pkey('lastReflectAt'), lastReflectAt);
  };
  const stripFns = (v) => JSON.parse(JSON.stringify(v ?? {}));

  function newVersion(id, p, ts) {
    return {
      id,
      createdAt: ts,
      strategy: {
        signals: (p.strategy?.signals ?? []).map(s => ({ ...s, params: { ...(s.params ?? {}) } })),
        risk: { ...(p.risk ?? {}) },
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

  /** Seed history once per symbol so indicators work immediately. */
  async function seedHistory() {
    if (product.market.kind !== 'multi') return;
    for (const w of (cfg.universe.watchlist(cfg) ?? []).slice(0, 20)) {
      if (seriesFor(w.symbol).length >= 30) continue; // enough bars already
      const key = pkey(`seeded:${w.symbol}`);
      const seededAt = db.getState(key) ?? 0;
      if (now() - seededAt < 30 * 60_000) continue; // retry at most every 30 min
      try {
        let rows = await fetchDailyHistory(fetchFn, w.symbol, 120).catch(() => []);
        if (rows.length < 30) {
          const minutes = await fetchMinuteHistory(fetchFn, w.symbol).catch(() => []);
          rows = [...rows, ...minutes];
        }
        for (const r of rows) {
          db.insertPoint({
            ts: r.ts, product: cfg.id, symbol: w.symbol,
            price: r.price, open: r.open ?? null, volume: r.volume ?? null,
          });
        }
        if (rows.length) db.putState(key, now());
      } catch { /* leave unseeded; retried after the throttle */ }
    }
  }

  async function tick() {
    const raw = await product.market.quote(fetchFn, cfg);
    quoteTs = now();
    if (product.market.kind === 'single') {
      quote = raw;
      db.insertTick({ ts: quoteTs, mid: raw.price, buy: raw.buy, sell: raw.sell, product: product.id });
      recordDayOpen({ [raw.symbol ?? product.id]: raw.price });
    } else {
      quote = Object.fromEntries(raw.quotes.map(q => [q.symbol, q]));
      for (const q of raw.quotes) {
        db.insertPoint({
          ts: quoteTs, product: product.id, symbol: q.symbol,
          price: q.price, open: q.open, volume: q.volume,
        });
      }
      recordDayOpen(Object.fromEntries(raw.quotes.map(q => [q.symbol, q.price])));
    }
    await seedHistory().catch(() => {});
    return quote;
  }

  function sessionDate() {
    return zonedParts(now(), product.timezone).date;
  }

  function recordDayOpen(prices) {
    const key = pkey(`dayOpen:${sessionDate()}`);
    const existing = db.getState(key);
    if (!existing) {
      db.putState(key, prices);
      return prices;
    }
    return existing;
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

  function volumesFor(symbol, limit = DEFAULT_SERIES) {
    if (product.market.kind === 'single') return [];
    return db.listPoints(product.id, symbol, limit).map(p => p.volume).filter(Number.isFinite);
  }

  /* ------------------------------ evaluation ------------------------------- */

  function evaluateSymbol(symbol, news = []) {
    const series = seriesFor(symbol);
    const signals = evaluateSignals(current().strategy.signals ?? cfg.strategy.signals, {
      series, volumes: volumesFor(symbol), news,
    });
    const score = compositeScore(signals);
    return { symbol, score, signals, price: priceOf(symbol) };
  }

  function candidates(news) {
    const list = product.market.kind === 'single'
      ? [product.universe.watchlist(cfg)[0]?.symbol ?? product.id]
      : product.universe.watchlist(cfg).map(w => w.symbol);
    const scored = list.map(s => evaluateSymbol(s, news));
    return { scored, picked: pickCandidates(scored, { threshold: cfg.strategy.candidates?.threshold ?? 0.8, topN: 5 }) };
  }

  /* ------------------------------- decisions ------------------------------- */

  function buildPrompt(ctx) {
    const p = cfg.strategy.prompt ?? {};
    const lines = [
      p.role ?? `你是${cfg.name}投资策略引擎。`,
      '',
      `## 市场（${cfg.name}，${cfg.currency}）`,
      JSON.stringify(ctx.market, null, 2),
      '',
      '## 持仓',
      JSON.stringify(ctx.positions, null, 2),
      '',
      '## 信号与候选',
      JSON.stringify(ctx.signals, null, 2),
      JSON.stringify(ctx.picked, null, 2),
      '',
      '## 最新资讯',
      (ctx.news ?? []).slice(0, 12).map((n, i) => `${i + 1}. ${n.title}`).join('\n') || '（暂无）',
      '',
      `## 规则`,
      ...(p.constraints ?? []).map(c => `- ${c}`),
      '',
      '只输出 JSON：{"action":"buy|sell|hold","symbol":"...","amount":金额或null,"qty":数量或null,"reason":"...","confidence":0~1,"plan":{...}}',
    ];
    return lines.join('\n');
  }

  function parseReflection(raw) {
    try {
      const m = String(raw ?? '').match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = JSON.parse(m[0]);
      return {
        critique: String(j.critique ?? ''),
        params: j.params != null && typeof j.params === 'object' ? j.params : {},
      };
    } catch {
      return null;
    }
  }

  function parseDecision(raw) {
    try {
      const txt = String(raw ?? '');
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = JSON.parse(m[0]);
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
        plan: j.plan ?? null,
      };
    } catch {
      return null;
    }
  }

  /* --------------------------------- gates --------------------------------- */

  function tradesToday() {
    const today = sessionDate();
    return db.listTradesByProduct(product.id, 200).filter(t => zonedParts(t.ts, product.timezone).date === today);
  }

  function dailyLossHit() {
    const total = snapshotOf(account, priceOf).totalPnl;
    const base = account.initial + (current().startPnl ?? 0);
    return base > 0 && (total - current().startPnl) / base * 100 <= (cfg.risk?.dailyLossPct ?? -2);
  }

  function exposureOf() {
    return snapshotOf(account, priceOf).positionsValue;
  }

  function fillPrice(side, symbol) {
    if (product.market.kind === 'single') {
      return side === 'buy' ? (quote?.buy ?? quote?.price) : (quote?.sell ?? quote?.price);
    }
    return priceOf(symbol);
  }

  function buyQuantity(decision, symbol, price) {
    if (decision.qty != null && decision.qty > 0) return decision.qty;
    const amount = decision.amount ?? cfg.risk?.perTrade ?? 0;
    return roundLot(cfg.rules, amount / price);
  }

  function execute(decision) {
    const symbol = decision.symbol ?? (product.market.kind === 'single' ? (product.universe.watchlist(cfg)[0]?.symbol ?? product.id) : null);
    if (!symbol) return { ok: false, reason: '缺目标标的' };
    const price = fillPrice(decision.action, symbol);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: '无有效行情' };

    if (!isSessionOpen(cfg.rules, now(), cfg.timezone)) return { ok: false, reason: '非交易时段' };

    const prevClose = prevCloseOf(symbol);
    if (!withinPriceBand(cfg.rules, prevClose, price)) return { ok: false, reason: '超出涨跌停价格区间' };

    // Frequency discipline.
    const dayTrades = tradesToday();
    const plan = current().strategy?.plan ?? {};
    const maxPerDay = Math.min(plan.maxTradesPerDay ?? 3, cfg.risk?.maxTradesPerDay ?? 3);
    if (dayTrades.length >= maxPerDay) return { ok: false, reason: `已达每日交易上限(${maxPerDay})` };
    const minGap = (plan.minIntervalHours ?? 0) * 3600_000;
    const lastTrade = dayTrades[0];
    if (lastTrade && now() - lastTrade.ts < minGap) return { ok: false, reason: '未达最小交易间隔' };

    if (decision.action === 'buy') {
      const qty = buyQuantity(decision, symbol, price);
      if (!(qty > 0)) return { ok: false, reason: '数量不足一手' };
      const notional = qty * price;
      const limit = Math.min(cfg.risk?.perTrade ?? notional, notional);
      if (notional > (cfg.risk?.perTrade ?? Infinity) + 1e-6) return { ok: false, reason: `超过单笔上限 ${cfg.risk.perTrade}` };
      const perSymbolCap = (account.initial * (cfg.risk?.perSymbolPct ?? 100)) / 100;
      if (exposureOf() + notional > Math.min(cfg.capital?.maxExposureRmb ?? account.initial, perSymbolCap)) {
        return { ok: false, reason: '超过单标的/总敞口上限' };
      }
      const fee = tradeFees(cfg.rules, 'buy', notional).total;
      if (notional + fee > account.cash + 1e-9) return { ok: false, reason: '现金不足' };
      applyBuy(account, { symbol, qty, price, fee, ts: now(), earliestSellTs: earliestSellTs(now(), cfg.rules, cfg.timezone) });
      db.insertTrade({ ts: now(), side: 'buy', grams: cfg.rules.unit === 'gram' ? qty : 0, price, rmb: notional, note: decision.reason, product: product.id, symbol });
      return { ok: true, side: 'buy', symbol, qty, price, fee, notional, reason: decision.reason };
    }

    if (decision.action === 'sell') {
      const pos = positionOf(account, symbol);
      if (!pos) return { ok: false, reason: '无持仓可卖' };
      const qty = decision.qty != null ? Math.min(decision.qty, pos.qty) : pos.qty;
      const sellQty = cfg.rules.unit === 'gram' ? qty : roundLot(cfg.rules, qty);
      if (!(sellQty > 0)) return { ok: false, reason: '卖出数量为0' };
      const notional = sellQty * price;
      const fee = tradeFees(cfg.rules, 'sell', notional).total;
      try {
        const r = applySell(account, { symbol, qty: sellQty, price, fee, ts: now() });
        db.insertTrade({ ts: now(), side: 'sell', grams: cfg.rules.unit === 'gram' ? sellQty : 0, price, rmb: notional, note: decision.reason, product: product.id, symbol });
        return { ok: true, side: 'sell', symbol, qty: sellQty, price, fee, notional, realized: r.realized, reason: decision.reason };
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) };
      }
    }
    return { ok: false, reason: 'hold' };
  }

  function riskCheck() {
    const stop = cfg.risk?.stopLossPct;
    const take = cfg.risk?.takeProfitPct;
    for (const symbol of Object.keys(account.positions)) {
      const p = account.positions[symbol];
      const price = priceOf(symbol);
      if (!Number.isFinite(price)) continue;
      const pct = ((price - p.costAvg) / p.costAvg) * 100;
      if (Number.isFinite(stop) && pct <= stop) return { kind: 'stop-loss', symbol, pct };
      if (Number.isFinite(take) && pct >= take) return { kind: 'take-profit', symbol, pct };
    }
    return { kind: 'none' };
  }

  /* -------------------------------- cycle ---------------------------------- */

  async function runCycle() {
    // Refresh quotes every cycle: gates and risk checks must see current prices.
    await tick().catch(() => {});
    if (!quote) return jsonSafe({ decision: { action: 'hold', reason: 'no quote' }, trades: [], llmError: null, paused });
    if (paused) return jsonSafe({ decision: { action: 'hold', reason: 'paused' }, trades: [], llmError: null, paused: true });
    if (newsIngest) {
      try { lastIngest = await newsIngest(); } catch { /* news is best-effort */ }
    }
    const news = (newsList?.() ?? []);

    const risk = riskCheck();
    let decision = null;
    let llmError = null;
    let rejection = null;
    let trades = [];

    if (risk.kind !== 'none') {
      decision = { action: 'sell', symbol: risk.symbol, reason: `风控触发：${risk.kind} ${risk.pct.toFixed(2)}%`, confidence: 1 };
    } else {
      const { scored, picked } = candidates(news);
      const ctx = {
        market: { price: quote, ts: quoteTs, currency: cfg.currency },
        positions: snapshotOf(account, priceOf).positions,
        signals: scored,
        picked,
        news,
      };
      try {
        const raw = await llm(buildPrompt(ctx));
        decision = parseDecision(raw);
      } catch (e) {
        llmError = String(e?.message ?? e).slice(0, 300);
      }
      if (!decision) decision = { action: 'hold', reason: 'fallback hold', confidence: 0 };
      if (decision.action !== 'hold' && (decision.confidence ?? 0) < (cfg.risk?.minConfidence ?? 0.55)) {
        decision = { action: 'hold', reason: `置信度不足(${decision.confidence})`, confidence: decision.confidence };
      }
      if (dailyLossHit() && decision.action !== 'hold') {
        decision = { action: 'hold', reason: '单日亏损达到上限，暂停交易', confidence: decision.confidence };
      }
    }

    if (decision.action !== 'hold') {
      const r = execute(decision);
      if (r.ok) trades = [r];
      else rejection = r.reason;
    }
    if (lastIngest) lastIngest = { ...lastIngest };
    lastRun = { decision, trades, rejection, llmError };
    persist();
    return jsonSafe({ decision, trades, rejection, llmError, paused, quoteTs, ingest: lastIngest });
  }

  /* -------------------------------- status --------------------------------- */

  function status() {
    const snap = snapshotOf(account, priceOf);
    const watchSymbol = cfg.universe.watchlist(cfg)[0]?.symbol ?? product.id;
    const series = product.market.kind === 'single'
      ? db.latestTicksByProduct(product.id, 120).map(t => ({ ts: t.ts, price: t.price }))
      : db.listPoints(product.id, watchSymbol, 120).map(p => ({ ts: p.ts, price: p.price }));
    return jsonSafe({
      product: { id: cfg.id, name: cfg.name, currency: cfg.currency, unit: cfg.rules?.unit ?? 'share', order: cfg.order },
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
      ingest: lastIngest,
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
    return {
      returnPnl: Math.round((snap.totalPnl - start) * 100) / 100,
      returnPct: Math.round(((snap.totalPnl - start) / (account.initial || 1)) * 10000) / 100,
      fills: trades.length,
      closes: closes.length,
      holdingPnl: Math.round(snap.holdingPnl * 100) / 100,
      positions: snap.positions.length,
    };
  }

  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (cur[k] == null || typeof cur[k] !== 'object') return false;
      cur = cur[k];
    }
    const leaf = parts[parts.length - 1];
    if (!(leaf in cur)) return false;
    cur[leaf] = value;
    return true;
  }

  /** Apply only whitelisted, bounded parameter changes; returns applied patches. */
  function applyParams(target, params) {
    const whitelist = cfg.strategy.evolvable ?? [];
    const applied = {};
    for (const [path, raw] of Object.entries(params ?? {})) {
      const spec = whitelist.find(w => w.path === path);
      if (!spec) continue;
      let value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (Number.isFinite(spec.min)) value = Math.max(spec.min, value);
      if (Number.isFinite(spec.max)) value = Math.min(spec.max, value);
      if (setPath(target, path, value)) applied[path] = value;
    }
    return applied;
  }

  function buildReflectPrompt(stats) {
    return [
      `你是${cfg.name}策略复盘引擎。请检讨当前策略版本的表现并给出改进。`,
      '',
      '## 当前参数',
      JSON.stringify(current().strategy, null, 2),
      '',
      '## 版本表现',
      JSON.stringify(stats, null, 2),
      '',
      '## 最近决策',
      JSON.stringify(lastRun?.decision ?? null, null, 2),
      '',
      '## 可调整参数（只能改这些路径，且受上下界约束）',
      ...(cfg.strategy.evolvable ?? []).map(w => `- ${w.path} ∈ [${w.min}, ${w.max}] step ${w.step}`),
      '',
      '只输出 JSON：{"critique":"...","params":{"路径":数值}}',
    ].join('\n');
  }

  async function reflectIfDue({ force = false } = {}) {
    const stats = versionStats();
    const lossTriggered = stats.returnPct <= (cfg.risk?.reflectLossPct ?? -3);
    const intervalMs = (cfg.reflectIntervalHours ?? 24) * 3600_000;
    const periodicDue = now() - lastReflectAt >= intervalMs;
    if (!force && !lossTriggered && !periodicDue) return jsonSafe({ reflected: false, stats });
    let parsed = null;
    try {
      parsed = parseReflection(await llm(buildReflectPrompt(stats)));
    } catch { /* llm failure keeps the version */ }
    const critique = String(parsed?.critique ?? '').slice(0, 800) || null;
    const params = parsed?.params ?? {};

    const next = newVersion(versions.length + 1, cfg, now());
    next.strategy = JSON.parse(JSON.stringify(current().strategy));
    const applied = applyParams(next.strategy, params);
    const changed = Object.keys(applied).length > 0;
    const journal = db.getState(pkey('reflections')) ?? [];
    journal.push({
      ts: now(), trigger: force ? 'manual' : lossTriggered ? 'loss' : 'periodic',
      stats, critique, applied, versionCreated: changed || lossTriggered,
    });
    db.putState(pkey('reflections'), journal.slice(-100));
    lastReflectAt = now();

    if (changed || lossTriggered) {
      next.startPnl = snapshotOf(account, priceOf).totalPnl;
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

  return {
    id: cfg.id,
    product: cfg,
    tick,
    runCycle,
    reflectIfDue,
    status,
    ingestNews,
    listNews: (limit) => (typeof newsList === 'function' ? newsList(limit) : []),
    get quote() { return quote; },
    get account() { return account; },
    snapshot: () => snapshotOf(account, priceOf),
    pause: (v) => { paused = v === undefined ? !paused : !!v; persist(); return paused; },
    get paused() { return paused; },
  };
}
