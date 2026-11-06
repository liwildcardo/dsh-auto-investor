/**
 * Orchestration service: feeds -> store -> strategist -> rules -> portfolio,
 * with the reflection loop. Dependency-injected (fetchFn, llm, now) so the
 * whole engine is testable; index.js wires it to real Host services.
 */
import { quoteFrom, parseGoldApi, parseFxApi, summarize, chartModel } from './market.js';
import { ingestFeeds, ingestSearchResults, rankNews, backfillPublishDates } from './news.js';
import { isTradingTime, validateTrade, shanghaiClock, sessionDate } from './rules.js';
import {
  createPortfolio, buy, sell, snapshot, toTerm, fromTerm, settleDemandYield,
} from './portfolio.js';
import {
  extractJson, parseStrategy, baselineStrategy, buildPrompt, buildReflectPrompt, resolvePlan,
} from './strategist.js';
import {
  createVersion, recordOutcome, shouldReflect, stabilityCheck, versionStats,
} from './reflector.js';
import { jsonSafe } from './json.js';

export function createService({ db, cfg, fetchFn, llm, now = () => Date.now(), searchFn = undefined }) {
  // Fallback web-search enrichment: manual runs (dashboard button / agent tool)
  // get the same inputs as the scheduler without every caller re-wiring it.
  const defaultSearchFn = searchFn;
  let portfolio = db.getState('portfolio') ?? createPortfolio(cfg.initialCapitalRmb);
  let versions = db.getState('versions') ?? [createVersion(1, { action: 'hold', reason: 'initial version' }, now())];
  let quote = db.getState('lastQuote') ?? null;
  let quoteTs = db.getState('quoteTs') ?? null;
  let dayOpen = db.getState('dayOpenQuote') ?? null; // {date, quote}
  let benchmark = db.getState('benchmark') ?? null; // {sell, ts} buy-and-hold baseline
  let paused = db.getState('paused') ?? false;
  let lastIngest = db.getState('lastIngest') ?? null; // last news-ingest stats (feed health)
  let lastReflectAt = db.getState('lastReflectAt') ?? now();
  let dayLossHit = false;
  let sessionKey = null;
  if (!Array.isArray(versions) || versions.length === 0) versions = [createVersion(1, { action: 'hold', reason: 'initial version' })];

  // Backfill the day-open baseline from the earliest tick of the current
  // session. This also corrects a baseline persisted by an older upgrade
  // that started mid-day.
  {
    const today = shanghaiClock(now()).date;
    const first = db.latestTicks(5000).find(t => shanghaiClock(t.ts).date === today);
    if (first) dayOpen = { date: today, quote: { mid: first.mid, buy: first.buy, sell: first.sell } };
  }
  let nextVersionId = versions.reduce((m, v) => Math.max(m, v.id), 0) + 1;

  // One-time purge. v5: rows written before publish-date resolution stored
  // batch/crawl time as the publish date; drop them once so feeds re-ingest
  // with real article dates (or a clearly-marked estimate).
  const purgeKey = 'newsRelevanceVersion';
  if ((db.getState(purgeKey) ?? 0) < 5) {
    for (const n of db.latestNews(5000)) db.removeNews(n.hash);
    db.putState(purgeKey, 5);
  }

  /** Effective frequency plan: current strategy's plan clamped by hard caps. */
  const currentPlan = () => resolvePlan(current().strategy?.plan, cfg);

  const persist = () => {
    db.putState('portfolio', portfolio);
    db.putState('versions', versions);
    if (quote) db.putState('lastQuote', quote);
    if (quoteTs) db.putState('quoteTs', quoteTs);
    if (dayOpen) db.putState('dayOpenQuote', dayOpen);
    db.putState('lastReflectAt', lastReflectAt);
  };

  /**
   * Return base for percentage metrics: capital actually deployed, so a small
   * book is judged on its own performance instead of the 100k ceiling.
   */
  const capitalBase = () => (portfolio.investedRmb > 0 ? portfolio.investedRmb : (cfg.initialCapitalRmb || 1));

  const current = () => versions[versions.length - 1];

  // One-time baseline migration: a version born before the first fill had an
  // empty book, so its inception P&L baseline is 0. (A mid-life lazy init had
  // recorded a wrong startPnl for legacy versions such as v1.)
  {
    const fillsAsc = db.listTrades(5000).slice().reverse();
    const firstFill = fillsAsc.length ? fillsAsc[0].ts : null;
    let changed = false;
    for (const v of versions) {
      if (firstFill !== null && v.createdAt < firstFill && v.startPnl !== 0) {
        v.startPnl = 0;
        changed = true;
      }
    }
    if (changed) persist();
  }

  /**
   * Display stats for one version: real fill/close counts from the trade log
   * plus marked-to-market return and peak-to-trough drawdown. The return
   * baseline is the version's inception P&L (startPnl, or the replayed book
   * value at birth when startPnl was never recorded).
   */
  function versionDisplay(v, index, shared) {
    const isCurrent = index === versions.length - 1;
    const endTs = isCurrent ? now() : (versions[index + 1]?.createdAt ?? now());
    const asc = (a) => [...a].sort((x, y) => x.ts - y.ts);
    const fillsAsc = asc(shared?.fills ?? db.listTrades(5000));
    const allTicks = shared?.ticks ?? db.latestTicks(20000);
    const openFills = fillsAsc.filter((t) => t.ts < v.createdAt);
    const winFills = fillsAsc.filter((t) => t.ts >= v.createdAt && (isCurrent ? t.ts <= endTs : t.ts < endTs));

    let grams = 0;
    let costAvg = 0;
    let realized = 0;
    const apply = (f) => {
      if (f.side === 'buy') {
        const add = f.grams;
        costAvg = (costAvg * grams + (f.rmb ?? f.price * f.grams)) / (grams + add);
        grams += add;
      } else if (f.side === 'sell') {
        realized += (f.price - costAvg) * f.grams;
        grams -= f.grams;
        if (grams < 1e-9) { grams = 0; costAvg = 0; }
      }
      // toTerm / fromTerm move between buckets; total grams unchanged.
    };
    openFills.forEach(apply);

    const beforeTicks = allTicks.filter((t) => t.ts <= v.createdAt);
    const priceAt = beforeTicks.length ? beforeTicks[beforeTicks.length - 1] : allTicks[0];
    const baseline = v.startPnl ?? (realized + (priceAt ? (priceAt.sell - costAvg) * grams : 0));

    // Drawdown from the marked-to-market return curve inside the version window.
    const winTicks = allTicks.filter((t) => t.ts >= v.createdAt && (isCurrent ? t.ts <= endTs : t.ts < endTs));
    let fi = 0;
    let closes = 0;
    let wins = 0;
    let peak = 0;
    let maxDD = 0;
    let lastTotal = null;
    const consume = (f) => {
      if (f.side === 'sell') {
        closes += 1;
        if (f.price > costAvg) wins += 1;
      }
      apply(f);
    };
    const sample = (total) => {
      lastTotal = total;
      const r = total - baseline;
      if (r > peak) peak = r;
      const dd = r - peak;
      if (dd < maxDD) maxDD = dd;
    };
    for (const tick of winTicks) {
      while (fi < winFills.length && winFills[fi].ts <= tick.ts) consume(winFills[fi++]);
      sample(realized + (tick.sell - costAvg) * grams);
    }
    while (fi < winFills.length) consume(winFills[fi++]);
    if (isCurrent && quote) sample(snapshot(portfolio, quote, null).totalPnl);

    // End-of-version total P&L: live for current, frozen at the fork for retired.
    let endTotal;
    if (isCurrent && quote) endTotal = snapshot(portfolio, quote, null).totalPnl;
    else if (!isCurrent && versions[index + 1]?.startPnl != null) endTotal = versions[index + 1].startPnl;
    else endTotal = lastTotal ?? baseline;

    return {
      fills: winFills.length,
      closes,
      wins,
      winRate: closes > 0 ? wins / closes : null,
      // Round consistently: tick-replay samples and snapshot totals must share
      // the same precision, or the drawdown trough flips on rounding noise.
      returnPnl: Math.round((endTotal - baseline) * 100) / 100,
      maxDrawdownPnl: Math.round(maxDD * 100) / 100,
    };
  }

  /**
   * Version stats marked to market: the display stats are the source of truth
   * (real closes + inception baseline), overlaying the raw counters.
   */
  function markedStats() {
    const v = current();
    const base = capitalBase();
    const stats = versionStats(v, base);
    const d = versionDisplay(v, versions.length - 1);
    return {
      ...stats,
      // Explicit fill/close split: `trades` counts closed round-trips, `fills`
      // counts every execution — otherwise "trades: 0" after four buys reads
      // as broken bookkeeping to the model and to the user.
      trades: d.closes,
      closes: d.closes,
      fills: d.fills,
      wins: d.wins,
      winRate: d.closes > 0 ? d.wins / d.closes : 0,
      returnPnl: d.returnPnl,
      returnPct: (d.returnPnl / base) * 100,
      maxDrawdownPnl: d.maxDrawdownPnl,
      maxDrawdownPct: (d.maxDrawdownPnl / base) * 100,
    };
  }

  const bookOutcome = (pnlDelta) => {
    recordOutcome(current(), pnlDelta);
    // Judge "reference-worthy" on the same marked-to-market stats the user
    // sees, not the raw realized counters (which ignore unrealized swings).
    const stats = markedStats();
    if (!current().reference && stabilityCheck(stats, cfg, benchmarkReturnPct())) current().reference = true;
    persist();
    return stats;
  };

  /** Buy-and-hold benchmark return (%) since the first market fill. */
  function benchmarkReturnPct() {
    if (!benchmark || !quote || benchmark.sell === 0) return undefined;
    return ((quote.sell - benchmark.sell) / benchmark.sell) * 100;
  }

  /** Total-return (%) on invested capital (realized + unrealized). */
  function totalReturnPct() {
    const s = snapshot(portfolio, quote, null);
    return (s.totalPnl / capitalBase()) * 100;
  }

  /** Force a risk exit (bypasses frequency/staleness; these are safety stops). */
  function forceRiskSell(grams, note) {
    const before = portfolio.realizedPnl;
    sell(portfolio, grams, quote.sell);
    db.insertTrade({ ts: now(), side: 'sell', grams, price: quote.sell, rmb: grams * quote.sell, note });
    bookOutcome(portfolio.realizedPnl - before);
    persist();
    return { kind: note === '止损' ? 'stopLoss' : 'takeProfit', trades: [{ ts: now(), side: 'sell', grams, price: quote.sell }], reason: note };
  }

  /**
   * Stop-loss / take-profit discipline. Returns {kind:'none'} when no action.
   * stop-loss uses the tighter of the plan stop and the global hard floor.
   */
  function riskCheck() {
    if (!quote) return { kind: 'none', trades: [], reason: null };
    const s = snapshot(portfolio, quote, null);
    if (s.grams <= 0) return { kind: 'none', trades: [], reason: null };
    const plan = currentPlan();
    const effStop = Math.max(plan.stopLossPct ?? cfg.hardStopLossPct, cfg.hardStopLossPct);
    if (s.holdingReturnPct <= effStop) {
      return forceRiskSell(s.grams, '止损');
    }
    const tp = plan.takeProfitPct ?? 6;
    if (s.holdingReturnPct >= tp) {
      const g = Math.round(s.grams * cfg.takeProfitFraction * 10000) / 10000;
      if (g > 0) return forceRiskSell(g, '止盈');
    }
    return { kind: 'none', trades: [], reason: null };
  }

  /** Pause the engine when total return breaches the circuit-breaker floor. */
  function checkBreaker() {
    const tr = totalReturnPct();
    const hit = tr <= cfg.circuitBreakerPct;
    if (hit && !paused) {
      paused = true;
      db.putState('paused', true);
    }
    return hit;
  }

  async function tickPrices() {
    const goldRes = await fetchFn('https://api.gold-api.com/price/XAU');
    const gold = goldRes.ok ? parseGoldApi(await goldRes.json()) : null;
    const fxRes = await fetchFn('https://open.er-api.com/v6/latest/USD');
    const fx = fxRes.ok ? parseFxApi(await fxRes.json()) : null;
    if (gold == null || fx == null) {
      if (quote) return quote;
      throw new Error('price feeds unavailable');
    }
    const q = quoteFrom(gold, fx, cfg.spreadCnyPerGram, cfg.gramsPerOunce);
    const ts = now();
    quote = q;
    quoteTs = ts;
    const { date } = shanghaiClock(ts);
    if (!dayOpen || dayOpen.date !== date) dayOpen = { date, quote: q };
    const sess = sessionDate(ts, cfg);
    if (sessionKey !== sess) { sessionKey = sess; dayLossHit = false; }
    db.insertTick({ ts, xauUsd: gold, usdCny: fx, mid: q.mid, buy: q.buy, sell: q.sell });
    persist();
    return q;
  }

  async function ingestNews(searchFn) {
    const feed = await ingestFeeds(fetchFn, db, cfg)
      .catch((e) => ({ fetched: 0, kept: 0, stored: 0, bySource: {}, error: String(e?.message ?? e).slice(0, 120) }));
    let searched = 0;
    let searchError = null;
    if (typeof searchFn === 'function') {
      try {
        const results = await searchFn(['央行增持黄金', '伦敦金 黄金价格 走势', '美联储 利率 黄金']);
        searched = await ingestSearchResults(fetchFn, db, results, 'web-search', cfg);
      } catch (e) {
        searchError = String(e?.message ?? e).slice(0, 120); // best-effort, but visible
      }
    }
    // Converge the backlog: upgrade stored estimates, drop ones proven stale.
    const backfill = await backfillPublishDates(fetchFn, db, 12, cfg)
      .catch(() => ({ upgraded: 0, dropped: 0 }));
    // Keep the last run's stats so the dashboard/agent can tell a dead feed
    // (error) apart from a genuinely empty one (0 items, no error).
    lastIngest = {
      ts: now(), ...feed, searched, searchError,
      datesResolved: backfill.upgraded, datesDropped: backfill.dropped,
    };
    db.putState('lastIngest', lastIngest);
    return lastIngest;
  }

  function buildContext() {
    return {
      summary: summarize(db.latestTicks(24)),
      position: snapshot(portfolio, quote, dayOpen?.quote ?? null),
      // rankNews: relevance×recency order + near-duplicate collapse, so the
      // ten prompt slots hold the most decision-relevant, freshest items.
      news: rankNews(db.latestNews(cfg.newsLimit), now()),
      trades: db.listTrades(10),
      portfolioFills: db.listTrades(500).length, // all-time executions (prompt clarity)
      stats: markedStats(),
      plan: currentPlan(),
    };
  }

  function executeDecision(decision, ts) {
    if (!decision || decision.action === 'hold') return { trades: [], rejection: null };
    const check = validateTrade(
      { side: decision.action, rmb: decision.amountRmb, grams: decision.grams, ts },
      portfolio, quote, cfg,
      { plan: currentPlan(), trades: db.listTrades(500), quoteTs, quoteMaxAgeSec: cfg.quoteMaxAgeSec },
    );
    if (!check.ok) return { trades: [], rejection: check.reason };
    const trades = [];
    const push = (side, grams, price, rmb, note) => {
      db.insertTrade({ ts, side, grams, price, rmb, note: note ?? decision.reason?.slice(0, 200) ?? '' });
      trades.push({ ts, side, grams, price, rmb });
    };
    switch (decision.action) {
      case 'buy': {
        const rmb = decision.amountRmb;
        const grams = buy(portfolio, rmb, quote.buy);
        push('buy', grams, quote.buy, rmb);
        current().fills = (current().fills ?? 0) + 1;
        if (!benchmark) {
          benchmark = { sell: quote.sell, ts };
          db.putState('benchmark', benchmark);
        }
        break;
      }
      case 'sell': {
        const before = portfolio.realizedPnl;
        const proceeds = sell(portfolio, decision.grams, quote.sell);
        push('sell', decision.grams, quote.sell, proceeds);
        bookOutcome(portfolio.realizedPnl - before);
        break;
      }
      case 'toTerm': {
        const g = toTerm(portfolio, decision.grams);
        push('toTerm', g, quote.sell, 0);
        current().fills = (current().fills ?? 0) + 1;
        break;
      }
      case 'fromTerm': {
        const g = fromTerm(portfolio, decision.grams);
        push('fromTerm', g, quote.sell, 0);
        current().fills = (current().fills ?? 0) + 1;
        break;
      }
      default:
        break; // hold: nothing to book
    }
    persist();
    return { trades, rejection: null };
  }

  async function runCycle(searchFn) {
    if (!quote) await tickPrices().catch(() => {});
    if (paused) {
      return jsonSafe({ decision: { action: 'hold', reason: 'circuit breaker engaged' }, trades: [], rejection: null, llmError: null, paused: true, circuitBreaker: true, dayLossHit });
    }
    await ingestNews(searchFn ?? defaultSearchFn);
    const s0 = snapshot(portfolio, quote, dayOpen?.quote ?? null);
    const dayPct = portfolio.investedRmb > 0 ? (s0.todayPnl / portfolio.investedRmb) * 100 : 0;
    if (dayPct <= cfg.dailyLossLimitPct) dayLossHit = true;

    let decision = null;
    let trades = [];
    let rejection = null;
    let llmError = null;
    let newsSnapshot = null; // what the model actually saw, for the learning loop

    // Risk discipline runs before strategy: stop-loss / take-profit.
    const risk = riskCheck();
    if (risk.kind !== 'none') {
      decision = { action: 'sell', reason: risk.reason, forcedRisk: risk.kind };
      trades = risk.trades;
    } else {
      const ctx = buildContext();
      newsSnapshot = ctx.news.slice(0, 10).map(n => ({ ts: n.ts, source: n.source, title: String(n.title).slice(0, 120) }));
      let raw = null;
      try {
        raw = await llm(buildPrompt(ctx, cfg));
        decision = parseStrategy(extractJson(raw));
      } catch (e) {
        llmError = String(e?.message ?? e).slice(0, 300);
      }
      if (!decision) decision = parseStrategy(baselineStrategy(ctx)) ?? { action: 'hold', reason: 'fallback hold' };
      // Confidence gate: low-confidence trades are held.
      if (decision.action !== 'hold' && (decision.confidence ?? 0) < cfg.minConfidence) {
        decision = { action: 'hold', reason: `置信度不足(${decision.confidence})，忽略该信号`, confidence: decision.confidence };
      }
      // The frequency plan is part of the strategy: adopt the LLM's plan (clamped).
      if (decision.plan) {
        current().strategy = { ...current().strategy, plan: resolvePlan(decision.plan, cfg) };
      }
      // Daily-loss gate: no new discretionary trades for the rest of the session.
      if (dayLossHit && decision.action !== 'hold') {
        decision = { action: 'hold', reason: '单日亏损已触及上限，本交易日暂停交易', confidence: decision.confidence };
      }
      const ts = now();
      ({ trades, rejection } = quote && isTradingTime(ts, cfg)
        ? executeDecision(decision, ts)
        : { trades: [], rejection: isTradingTime(ts, cfg) ? null : 'outside trading window (交易时段)' });
    }

    const breaker = checkBreaker();
    // Audit trail for the learning loop (bounded). `news` records the exact
    // headlines in context, so later reviews can correlate decisions with input.
    const journal = db.getState('decisions') ?? [];
    journal.push({ ts: now(), decision, trades, rejection, llmError, news: newsSnapshot });
    if (journal.length > 200) journal.splice(0, journal.length - 200);
    db.putState('decisions', journal);
    persist();
    // Surface feed health with the run itself: callers see per-source
    // fetched/kept/stored/errors without a second status() round-trip.
    return jsonSafe({ decision, trades, rejection, llmError, paused, circuitBreaker: breaker, dayLossHit, ingest: lastIngest });
  }

  /**
   * Reflection pass. Runs when EITHER a loss signal fires OR the periodic
   * review (reflectIntervalHours, default 24h) is due; `force: true` bypasses
   * both gates (manual review). A periodic review only forks a new version
   * when the plan materially changed, so version stats stay continuous while
   * the strategy keeps being re-examined.
   */
  async function reflectIfDue(options = {}) {
    const forced = options.force === true;
    const totalPnl = quote ? snapshot(portfolio, quote, null).totalPnl : 0;
    const stats = markedStats();
    const lossTriggered = shouldReflect(stats, cfg);
    const intervalMs = (cfg.reflectIntervalHours ?? 24) * 3600_000;
    const periodicDue = now() - lastReflectAt >= intervalMs;
    if (!forced && !lossTriggered && !periodicDue) {
      return { reflected: false, trigger: null, stats, lastReflectAt, nextReflectAt: lastReflectAt + intervalMs };
    }
    const ctx = buildContext();
    // Feedback loop: show the model what it saw last cycle and what it did,
    // so the critique can judge whether news-based reasoning paid off.
    const lastDecision = (db.getState('decisions') ?? []).at(-1) ?? null;
    ctx.lastDecision = lastDecision
      ? { ts: lastDecision.ts, decision: lastDecision.decision, trades: lastDecision.trades, rejection: lastDecision.rejection, news: lastDecision.news }
      : null;
    const raw = await llm(buildReflectPrompt(current(), stats, ctx, cfg)).catch(() => null);
    if (raw == null) return { reflected: false, trigger: null, stats, error: 'reflection LLM unavailable' };
    const parsed = parseStrategy(extractJson(raw ?? '')) ?? { action: 'hold', reason: 'reflection hold' };
    const critique = extractJson(raw ?? '')?.critique ?? null;
    lastReflectAt = now();
    const trigger = lossTriggered ? 'loss' : (periodicDue && !forced ? 'periodic' : 'manual');

    // A version forks on loss, or on a material plan change found by a periodic review.
    const proposedPlan = parsed.plan ? resolvePlan(parsed.plan, cfg) : null;
    const planChanged = proposedPlan !== null && JSON.stringify(proposedPlan) !== JSON.stringify(currentPlan());
    const fromVersion = current().id;

    // Every review is journaled with its conclusion (bounded, persisted).
    const journal = db.getState('reflections') ?? [];
    const record = (toVersion, versionCreated) => {
      journal.push({
        ts: lastReflectAt,
        trigger,
        stats: {
          returnPct: stats.returnPct,
          consecLosses: stats.consecLosses,
          maxDrawdownPct: stats.maxDrawdownPct,
        },
        critique,
        action: parsed.action,
        fromVersion,
        toVersion,
        versionCreated,
      });
      if (journal.length > 100) journal.splice(0, journal.length - 100);
      db.putState('reflections', journal);
    };

    if (lossTriggered || planChanged) {
      current().retired = true;
      const v = createVersion(nextVersionId++, {
        ...parsed,
        critique,
        plan: proposedPlan ?? currentPlan(),
        parentVersion: fromVersion,
      }, now());
      v.startPnl = totalPnl;
      versions.push(v);
      record(v.id, true);
      persist();
      return { reflected: true, trigger, stats, version: v, versionCreated: true, lossTriggered };
    }

    // Periodic review with an unchanged plan: record the review, keep the version.
    current().lastReview = { ts: lastReflectAt, critique };
    record(fromVersion, false);
    persist();
    return { reflected: true, trigger, stats, versionCreated: false, lastReflectAt, nextReflectAt: lastReflectAt + intervalMs };
  }

  function manualTrade(op) {
    const ts = now();
    if (!quote) return jsonSafe({ ok: false, reason: 'no quote yet' });
    let decision;
    switch (op?.side) {
      case 'buy': decision = { action: 'buy', amountRmb: op.rmb, reason: op.note ?? 'manual' }; break;
      case 'sell': decision = { action: 'sell', grams: op.grams, reason: op.note ?? 'manual' }; break;
      case 'toTerm': decision = { action: 'toTerm', grams: op.grams, reason: op.note ?? 'manual' }; break;
      case 'fromTerm': decision = { action: 'fromTerm', grams: op.grams, reason: op.note ?? 'manual' }; break;
      default:
        return jsonSafe({ ok: false, reason: `unknown side: ${String(op?.side)} (expected buy|sell|toTerm|fromTerm)` });
    }
    // Same validation path as automated trades: window, caps, frequency, staleness.
    const { trades, rejection } = executeDecision(decision, ts);
    if (rejection) return jsonSafe({ ok: false, reason: rejection });
    return jsonSafe({ ok: true, trades });
  }

  // Drop stored news whose real publish date is older than the freshness window
  // (archive rows ingested before the staleness rule existed).
  for (const n of db.latestNews(2000)) {
    if (!n.tsEstimated && now() - n.ts > (cfg.newsMaxAgeDays ?? 60) * 86400_000) {
      db.removeNews(n.hash);
    }
  }

  /** Dated items first (ts desc), then undated estimates — same policy as the prompt. */
  const sortNews = (items) => [...items].sort((a, b) =>
    (Number(a.tsEstimated ?? false) - Number(b.tsEstimated ?? false)) || (b.ts - a.ts));

  function status() {
    const ticks = db.latestTicks(240);
    // Share one pass of trades/ticks across every version's display stats.
    const shared = { fills: db.listTrades(5000), ticks: db.latestTicks(20000) };
    const withDisplay = versions.map((v, i) => ({ ...v, display: versionDisplay(v, i, shared) }));
    return jsonSafe({
      quote,
      quoteTs,
      dayOpenQuote: dayOpen?.quote ?? null,
      benchmark,
      benchmarkReturnPct: benchmarkReturnPct(),
      paused,
      dayLossHit,
      portfolio: snapshot(portfolio, quote, dayOpen?.quote ?? null),
      versions: withDisplay,
      currentVersion: withDisplay[withDisplay.length - 1],
      news: sortNews(db.latestNews(cfg.newsLimit * 3)).slice(0, cfg.newsLimit),
      ingest: lastIngest, // per-source feed health: {fetched, kept, stored, bySource, searched}
      trades: db.listTrades(20),
      ticks,
      chart: chartModel(ticks, 640, 180),
      plan: currentPlan(),
      tradingNow: isTradingTime(now(), cfg),
      lastReflectAt,
      reflectIntervalHours: cfg.reflectIntervalHours ?? 24,
      nextReflectAt: lastReflectAt + (cfg.reflectIntervalHours ?? 24) * 3600_000,
      reflections: db.getState('reflections') ?? [],
      cfg: {
        perTradeLimitRmb: cfg.perTradeLimitRmb,
        totalLimitRmb: cfg.totalLimitRmb,
        minTradeRmb: cfg.minTradeRmb,
        minTradeGrams: cfg.minTradeGrams,
        toTermMinGrams: cfg.toTermMinGrams,
        tradingWindow: cfg.tradingWindow,
      },
    });
  }

  /** Quarterly demand-deposit gram-yield settlement (克重收益), at most once per quarter. */
  function settleYield(annualPct = cfg.demandYieldAnnualPct, days = 91) {
    const { date } = shanghaiClock(now());
    const [y, m] = date.split('-');
    const quarterKey = `${y}Q${Math.ceil(Number(m) / 3)}`;
    if (db.getState('lastYieldSettlement') === quarterKey) return 0;
    const credited = settleDemandYield(portfolio, annualPct, days);
    db.putState('lastYieldSettlement', quarterKey);
    persist();
    return credited;
  }

  /** Lightweight queries for the UI routes (avoid recomputing full status). */
  const newsList = (limit) => jsonSafe(db.latestNews(
    limit === 0 ? 0 : (Number.isFinite(limit) && limit > 0 ? limit : cfg.newsLimit)));
  const tradesList = () => jsonSafe(db.listTrades(20));

  return {
    tickPrices,
    ingestNews,
    runCycle,
    reflectIfDue,
    manualTrade,
    settleYield,
    newsList,
    tradesList,
    status,
    riskCheck,
    isPaused: () => paused,
    pause: () => { paused = true; db.putState('paused', true); persist(); },
    resume: () => { paused = false; db.putState('paused', false); persist(); },
    // test/debug hooks
    bookOutcome,
    // bookOutcome books the realized delta; the marker must see it too, or a
    // forced loss (test hook) would never reach the marked-to-market return.
    debugForceLoss: (rmb) => {
      portfolio.realizedPnl -= Math.abs(rmb);
      return bookOutcome(-Math.abs(rmb));
    },
    get portfolio() { return portfolio; },
    get versions() { return versions; },
  };
}
