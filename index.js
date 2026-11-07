/**
 * 自动投资机 (Auto Investor) — Host half.
 * 多产品模拟投资：每个产品独立账户与引擎（黄金/A股/美股/港股），
 * LLM 决策 + 策略学习循环，暴露为 Agent 工具与 /api/auto-investor/* 路由。
 */
import { resolveConfig } from './lib/config.js';
import { openDb } from './lib/db.js';
import { registerTools } from './lib/tools.js';
import { registerRoutes } from './lib/routes.js';
import { collectStream } from './lib/llm.js';
import { normalizeWebSearch } from './lib/news.js';
import { loadProducts, mergeProduct } from './core/registry.js';
import { createProductEngine } from './core/engine.js';
import { createProductNews } from './core/news-service.js';
import { createHub } from './core/hub.js';
import { migrateGoldState } from './core/migrate.js';

export const inject = ['tools', 'llm', 'connection'];

export function apply(ctx, config) {
  const cfg = resolveConfig(config ?? {});
  const dataDir = config?.dataDir
    ?? `${process.env.DSH_HOME ?? process.env.HOME ?? '.'}/auto-investor-data`;
  const db = openDb(`${dataDir}/auto-investor.db`);
  migrateGoldState(db);

  // LLM adapter: stream from the configured provider/model, join text deltas.
  // Provider/model entries may be strings or objects across adapter versions.
  const pickId = (entry, ...keys) => {
    if (typeof entry === 'string') return entry;
    for (const k of keys) {
      const v = entry?.[k];
      if (typeof v === 'string' && v !== '') return v;
    }
    return undefined;
  };
  // Resolved provider/model of the last call — persisted so the dashboard can
  // show the engine's model even before the first call after a restart.
  let lastLlm = db.getState('llm:last') ?? null;
  /** Resolved provider/model + today's call count, read live from storage. */
  function llmInfo() {
    const dayKey = `llm:calls:${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)}`;
    const callsToday = Number(db.getState(dayKey) ?? 0);
    if (!lastLlm) return callsToday > 0 ? { provider: null, model: null, at: null, callsToday } : null;
    return { ...lastLlm, callsToday };
  }
  async function llmCall(prompt) {
    // Model resolution: explicit config -> user's current default model
    // (agentDefaultModel) -> first provider with an advertised model.
    // NOTE: this is the harness DEFAULT model, not the per-conversation picker.
    let provider = config?.llmProvider ?? undefined;
    let model = config?.llmModel ?? undefined;
    if (!provider || !model) {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      provider ??= pickId(sel, 'provider', 'providerId');
      model ??= pickId(sel, 'model', 'modelId', 'id', 'name');
    }
    if (!provider) {
      const providers = ctx.llm.listProviders();
      provider = pickId(providers[0], 'id', 'name', 'provider', 'providerId') ?? String(providers[0] ?? '');
    }
    if (!provider) throw new Error('no LLM provider registered');
    if (!model) {
      const models = await ctx.llm.listModels(provider);
      model = pickId(models[0], 'id', 'name', 'model', 'modelId');
    }
    if (!model) throw new Error(`no LLM model resolved (provider ${provider}; set config llmProvider/llmModel)`);
    const dayKey = `llm:calls:${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)}`;
    const used = Number(db.getState(dayKey) ?? 0);
    const maxCalls = config?.llmDailyMaxCalls ?? cfg.llmDailyMaxCalls ?? 300;
    if (maxCalls > 0 && used >= maxCalls) {
      throw new Error(`LLM 每日调用上限已达 (${maxCalls})，本轮降级为规则信号`);
    }
    try { db.putState(dayKey, used + 1); } catch { /* best effort */ }
    lastLlm = { provider, model, at: Date.now(), callsToday: used + 1 }; // shown in status for transparency
    try { db.putState('llm:last', lastLlm); } catch { /* best effort */ }
    return collectStream(ctx.llm.stream({
      provider,
      model,
      signal: AbortSignal.timeout(60_000),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    }), { timeoutMs: 90_000 });
  }

  const fetchFn = (url, opts) => globalThis.fetch(url, opts);

  // Optional web-search enrichment; the plugin stays functional without it.
  const web = ctx.get('web');
  const searchFn = web
    ? async (queries) => {
      const items = [];
      for (const query of queries) {
        try {
          const res = await web.search({ query, maxResults: 5 });
          items.push(...normalizeWebSearch(res));
        } catch { /* one failed query must not kill enrichment */ }
      }
      return items;
    }
    : undefined;

  const products = loadProducts({
    enabled: Array.isArray(config?.products) ? config.products : undefined,
    overrides: buildOverrides(),
  });

  /** Map the documented plugin config onto product overrides (gold inherits the
   *  legacy keys; every product inherits the safety knobs). */
  function buildOverrides() {
    const base = config?.productConfig ?? {};
    const sharedRisk = {
      minConfidence: cfg.minConfidence,
      quoteMaxAgeSec: cfg.quoteMaxAgeSec,
      dailyLossPct: cfg.dailyLossLimitPct,
      reflectConsecLosses: cfg.reflectConsecLosses,
      reflectMaxDrawdownPct: cfg.reflectMaxDrawdownPct,
    };
    const gold = mergeProduct({
      capital: { initialRmb: cfg.initialCapitalRmb, maxExposureRmb: cfg.totalLimitRmb },
      risk: { perTrade: cfg.perTradeLimitRmb, ...sharedRisk },
      rules: { holidays: cfg.holidays ?? [] },
      market: { spreadCnyPerGram: cfg.spreadCnyPerGram, gramsPerOunce: cfg.gramsPerOunce },
    }, base.gold ?? {});
    const out = { ...base, gold };
    for (const id of ['ashare', 'us', 'hk']) {
      out[id] = mergeProduct({ risk: sharedRisk }, base[id] ?? {});
    }
    return out;
  }
  const now = () => Date.now();
  const engines = products.map((product) => {
    const news = createProductNews({ db, product, fetchFn, searchFn, now, cfg });
    return createProductEngine({
      db, product, llm: llmCall, fetchFn, now,
      newsIngest: news.ingest,
      newsList: news.list,
      llmInfo,
    });
  });
  const hub = createHub({ engines, products });
  const state = { lastRun: null };

  ctx.effect(() => registerTools(ctx, hub), 'auto-investor: tools');
  ctx.effect(() => registerRoutes(ctx, hub, state), 'auto-investor: routes');

  // Portable interval helper owned by the plugin's effect scope.
  const every = (ms, label, fn) => ctx.effect(() => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, label);

  // Initial price tick so the dashboards have data immediately.
  for (const e of engines) e.tick().catch(() => {});

  // Price polling (all products, one interval).
  every(cfg.pricePollSec * 1000, 'auto-investor: price poll', () => {
    for (const e of engines) {
      if (e.paused) continue;
      e.tick().catch(() => {});
    }
  });

  // News polling (market feeds + per-symbol cache) for every product.
  every(cfg.newsPollMin * 60_000, 'auto-investor: news poll', () => {
    for (const e of engines) {
      if (e.paused) continue;
      e.ingestNews?.().catch(() => {});
    }
  });

  // Strategy cycles, staggered per product so LLM calls do not burst together.
  const staggerMs = (config?.staggerSec ?? 120) * 1000;
  ctx.effect(() => {
    const stops = engines.map((engine, i) => {
      let interval = null;
      const start = setTimeout(() => {
        const run = async () => {
          if (engine.paused) return;
          try {
            await engine.runCycle();
            state.lastRun = Date.now();
            await engine.reflectIfDue();
          } catch { /* keep the loop alive across transient failures */ }
        };
        interval = setInterval(run, cfg.cycleMin * 60_000);
        run();
      }, 45_000 + i * staggerMs); // wait for ctx activation before the first LLM call
      return () => {
        clearTimeout(start);
        if (interval) clearInterval(interval);
      };
    });
    return () => { for (const stop of stops) stop(); };
  }, 'auto-investor: strategy cycles');

  return () => db.close();
}
