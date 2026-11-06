/**
 * 自动投资机 (Auto Investor) — Host half.
 * Gold simulated investing under 招行黄金账户 rules, LLM strategy + reflection
 * loop, exposed as agent tools and /api/auto-investor/* JSON routes.
 */
import { resolveConfig } from './lib/config.js';
import { openDb } from './lib/db.js';
import { createService } from './lib/service.js';
import { registerTools } from './lib/tools.js';
import { registerRoutes } from './lib/routes.js';
import { collectStream } from './lib/llm.js';
import { normalizeWebSearch } from './lib/news.js';

export const inject = ['tools', 'llm', 'connection'];

export function apply(ctx, config) {
  const cfg = resolveConfig(config ?? {});
  const dataDir = config?.dataDir
    ?? `${process.env.DSH_HOME ?? process.env.HOME ?? '.'}/auto-investor-data`;
  const db = openDb(`${dataDir}/auto-investor.db`);

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
  async function llmCall(prompt) {
    // Model resolution: explicit config -> user's current default model
    // (agentDefaultModel) -> first provider with an advertised model.
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

  const service = createService({ db, cfg, fetchFn, llm: llmCall, now: () => Date.now(), searchFn });
  const state = { lastRun: null };

  ctx.effect(() => registerTools(ctx, service), 'auto-investor: tools');
  ctx.effect(() => registerRoutes(ctx, service, state), 'auto-investor: routes');

  // Portable interval helper owned by the plugin's effect scope.
  const every = (ms, label, fn) => ctx.effect(() => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, label);

  // Initial price tick so the dashboard has data immediately.
  service.tickPrices().catch(() => {});

  // Price polling.
  every(cfg.pricePollSec * 1000, 'auto-investor: price poll', () => {
    if (service.isPaused()) return;
    service.tickPrices().catch(() => {});
  });

  // News polling.
  every(cfg.newsPollMin * 60_000, 'auto-investor: news poll', () => {
    if (service.isPaused()) return;
    service.ingestNews(searchFn).catch(() => {});
  });

  // Strategy cycle + reflection loop (交易-获取盈亏-修正策略).
  every(cfg.cycleMin * 60_000, 'auto-investor: strategy cycle', async () => {
    if (service.isPaused()) return;
    try {
      await service.runCycle(searchFn);
      state.lastRun = Date.now();
      await service.reflectIfDue();
    } catch { /* keep the loop alive across transient failures */ }
  });

  // Quarterly demand-deposit gram-yield settlement (每季度末月21日).
  every(6 * 3600_000, 'auto-investor: yield settlement', () => {
    const now = new Date();
    const isSettleDay = [2, 5, 8, 11].includes(now.getMonth()) // Mar/Jun/Sep/Dec
      && now.getDate() === 21;
    if (isSettleDay && !service.isPaused()) {
      service.settleYield(cfg.demandYieldAnnualPct);
    }
  });

  return () => db.close();
}
