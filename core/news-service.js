/**
 * 产品资讯：市场级采集（产品源 + 搜索）+ 池内标的资讯（带缓存与预算）。
 * 复用 lib/news.js 的解析、日期解析、陈旧剔除与排序。
 */
import { ingestFeeds, ingestSearchResults, rankNews, backfillPublishDates } from '../lib/news.js';

export function createProductNews({ db, product, fetchFn, searchFn = undefined, now = () => Date.now(), cfg = {} }) {
  const pid = product.id;
  // Gold keeps its tuned scorer (macro drivers like 央行/美联储 count); other
  // products use the generic product-keyword scorer.
  const relevance = product.news?.relevanceMode === 'gold' ? null : (product.news?.relevance ?? null);
  const maxAgeDays = cfg.newsMaxAgeDays ?? 60;
  const cfgFor = { ...cfg, productId: pid, newsMaxAgeDays: maxAgeDays };
  const stateKey = (k) => `product:${pid}:${k}`;

  /** Per-symbol search with a 6h cache and a bounded per-cycle budget. */
  async function ingestSymbolNews(budget = 12) {
    if (!product.news?.perSymbol || typeof searchFn !== 'function') return 0;
    const symbols = (product.universe.watchlist(cfg) ?? []).slice(0, budget);
    const baseRel = product.news?.relevance ?? { core: [], context: [] };
    let stored = 0;
    for (const s of symbols) {
      const key = stateKey(`symbolNews:${s.symbol}`);
      const last = db.getState(key) ?? 0;
      if (now() - last < 6 * 3600_000) continue;
      const short = String(s.symbol).replace(/^(sh|sz|us|hk)/i, '');
      // A story naming the stock is relevant to that stock even when it never
      // says "A股": the symbol name joins the core keyword set for this query.
      const rel = {
        core: [...(baseRel.core ?? []), s.name, short].filter(Boolean),
        context: baseRel.context ?? [],
        negative: baseRel.negative ?? [],
      };
      let results = [];
      try {
        results = await searchFn([`${s.name} ${short} 新闻 公告 业绩`]);
      } catch {
        continue; // one symbol failing must not stop the rest
      }
      try {
        stored += await ingestSearchResults(fetchFn, db, results, s.symbol, cfgFor, rel);
        db.putState(key, now());
      } catch { /* keep going */ }
    }
    return stored;
  }

  /**
   * Feed + per-symbol ingestion on the product's poll cadence. Product
   * web-search and date backfill moved OUT to their own slow timers
   * (frequency review P1/P4): the poll must stay cheap, and web.search
   * quota was burned for ~0 new items at 15-minute cadence.
   */
  async function ingest() {
    const feed = await ingestFeeds(fetchFn, db, cfgFor, product.news?.feeds ?? [], 15000, relevance)
      .catch(() => ({ fetched: 0, kept: 0, stored: 0, bySource: {} }));
    const perSymbol = await ingestSymbolNews().catch(() => 0);
    return { ts: now(), ...feed, perSymbol };
  }

  /** Product web-search on its own cadence (searchPollMin, default 4h). */
  async function searchWeb() {
    if (typeof searchFn !== 'function' || !(product.news?.queries ?? []).length) {
      return { ts: now(), searched: 0, searchError: null };
    }
    let searched = 0;
    let searchError = null;
    try {
      const results = await searchFn(product.news.queries);
      searched = await ingestSearchResults(fetchFn, db, results, 'web-search', cfgFor, relevance);
    } catch (e) {
      searchError = String(e?.message ?? e).slice(0, 120);
    }
    return { ts: now(), searched, searchError };
  }

  /** Date backfill on its own 6h timer; per-URL attempts are capped inside. */
  function backfill() {
    return backfillPublishDates(fetchFn, db, 8, cfgFor)
      .then(r => ({ ts: now(), ...r }))
      .catch(() => ({ ts: now(), upgraded: 0, dropped: 0 }));
  }

  const list = (limit = cfg.newsLimit ?? 20) => rankNews(db.latestNews(Math.max(1, limit) * 3, pid), now(), relevance).slice(0, limit);

  return { ingest, list, searchWeb, backfill };
}
