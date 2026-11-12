/**
 * News ingestion: RSS/Atom + HTML-list parsing with per-item publish dates
 * (undated items are flagged tsEstimated — never treated as fresh), gold-
 * investment relevance scoring, relevance×recency ranking for the prompt,
 * and feed ingestion into the store.
 */

/** Decode common HTML entities (named + numeric) in untrusted text. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&apos;/g, "'")
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘').replace(/&rsquo;/g, '’')
    .replace(/&hellip;/g, '…').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // &amp; last: don't double-decode already-resolved text
}

/** Strip CDATA wrappers and HTML tags from an XML text node value. */
export function extractText(s) {
  if (s == null) return '';
  let out = String(s);
  out = out.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
  out = out.replace(/<[^>]+>/g, ' ');
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

function tagValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

function atomLink(block) {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? m[1] : tagValue(block, 'link');
}

/** Parse RSS 2.0 or Atom XML into [{title, link, description, pubDate}]. */
export function parseRss(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return [];
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    items.push({
      title: tagValue(b, 'title'),
      link: tagValue(b, 'link'),
      description: tagValue(b, 'description'),
      pubDate: tagValue(b, 'pubDate') || tagValue(b, 'pubdate'),
    });
  }
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const b = m[0];
    items.push({
      title: tagValue(b, 'title'),
      link: atomLink(b),
      description: tagValue(b, 'summary') || tagValue(b, 'content'),
      pubDate: tagValue(b, 'updated') || tagValue(b, 'published'),
    });
  }
  return items.filter(i => i.title !== '' || i.link !== '');
}

/**
 * Parse an HTML index page (e.g. 央行新闻发布, 中国黄金协会) into news items.
 * @param html raw page
 * @param spec {linkPattern: RegExp (global, with capture groups url,title),
 *              datePattern?: RegExp (global, paired in document order),
 *              dateFromUrl?: RegExp (extract date from the resolved link),
 *              inner?: boolean (group 2 = anchor inner HTML: strip tags for
 *                the title, pick up an inline <div class="time"> or upload-path date),
 *              baseUrl: string}
 */
export function parseHtmlList(html, spec) {
  if (typeof html !== 'string' || !spec?.linkPattern) return [];
  // Product feeds may declare patterns as strings (config-friendly) or RegExp.
  const asGlobal = (p) => {
    if (p == null) return null;
    const re = typeof p === 'string' ? new RegExp(p, 'g') : new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    return re;
  };
  const linkRe = asGlobal(spec.linkPattern);
  const dateRe = asGlobal(spec.datePattern);
  const items = [];
  const dates = [];
  if (dateRe) {
    for (const m of html.matchAll(dateRe)) dates.push(m[1]);
  }
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    const url = m[1];
    let rawTitle;
    let innerDate = '';
    if (spec.inner) {
      // Group 2 is the anchor's inner HTML (title divs + optional date div or
      // dated upload image path). Strip tags for the title; lift the date out
      // separately so it never leaks into the title text.
      const inner = String(m[2] ?? '');
      innerDate = inner.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
      if (!innerDate) {
        // upload paths look like /upload/202611/06/202611061601228731.jpg (YYYY/MM/DD)
        const up = inner.match(/\/upload\/(\d{4})(\d{2})\/(\d{2})\//);
        if (up) innerDate = `${up[1]}-${up[2]}-${up[3]}`;
      }
      rawTitle = extractText(inner).replace(/\s*\d{4}-\d{2}-\d{2}\s*/g, ' ');
    } else {
      // title may arrive from group 2 (title attr / anchor text) or group 3 (img alt)
      rawTitle = m[2] ?? m[3] ?? '';
    }
    const title = String(rawTitle)
      .replace(/\s+teaser image$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!url || !title || title.length < 4) continue;
    const link = url.startsWith('http') ? url : `${spec.baseUrl ?? ''}${url}`;
    // Date precedence: per-item inner date > document-order pattern > URL path.
    let pubDate = innerDate || (dates[i] ?? '');
    if (!pubDate && spec.dateFromUrl) pubDate = link.match(spec.dateFromUrl)?.[1] ?? '';
    items.push({ title, link, description: '', pubDate });
    i += 1;
  }
  return items;
}

/* --------------------------- relevance scoring --------------------------- */

// Core investment-target terms: gold itself.
const GOLD_CORE = [
  '黄金', '伦敦金', '贵金属', '金价', '金条', '金饰', '金矿', '纸黄金', '黄金储备', '黄金ETF',
  'gold', 'xau', 'bullion', 'precious metal',
];
// Macro drivers that materially move gold (monetary policy, rates, inflation, geopolitics).
// 中国人民银行/人民银行: the PBoC's own feed titles never say "央行", so without
// these almost every official central-bank headline scored 0 and was dropped.
const MACRO_DRIVER = [
  '央行', '美联储', '利率', '降息', '加息', '通胀', 'cpi', '美元', '汇率', '地缘', '避险',
  '国债', '收益率', '货币政策', '流动性', 'fed', 'inflation', 'interest rate',
  '关税', '制裁', 'recession', 'pboc', '中国人民银行', '人民银行',
];
// Signals that a gold mention is about investing/pricing rather than a
// compound phrase (黄金周/黄金地段/黄金比例 ...).
const INVESTMENT_TITLE = [
  '金价', '价格', '储备', 'etf', '盎司', '期货', '克', '吨', '增持', '减持',
  '涨', '跌', '央行', '美联储', '利率', '美元', '矿业', '产量', '消费量',
  '周报', '市场', '投资', '行情', '持仓', 'gold price', 'above', 'below',
  'rally', 'surge', 'fall', 'rises', 'drops', '$',
];
// Economic context words that make a gold mention investment-relevant (nearby).
const ECON_CTX = [
  '价', '储备', '投资', '市场', '涨', '跌', '波动', '央行', '美元', 'ETF', '交易',
  '避险', '保值', '盎司', '矿业', '消费量', '产量', '克', 'policy', 'price', 'market',
];
// Negatives: false-positive compounds ("黄金菌群", "液体黄金") and unrelated sectors.
const NEG_CTX = [
  '菌群', '乳酸菌', '乳制品', '稻谷', '稻米', '美食', '烹饪', '手机', '文旅', '景区',
  '体育', '综艺', '电视剧', '机器人', '快递', '二手', '化妆品', '服装', '家电',
  '黄金周', '黄金档', '黄金时段', '黄金地段', '黄金比例', '黄金搭档', '黄金饰品',
  '旅游', '假期', '促销', '开业', '会见', '捐赠',
];

const WINDOW = 40;

function lower(s) {
  return String(s ?? '').toLowerCase();
}

function titleHasAny(hay, list) {
  return list.some(k => hay.includes(k));
}

/** A gold mention with economic context within ±WINDOW chars. */
function goldWithContext(hay) {
  for (const k of GOLD_CORE) {
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(k, from);
      if (idx === -1) break;
      const around = hay.slice(Math.max(0, idx - WINDOW), idx + k.length + WINDOW);
      if (ECON_CTX.some(c => around.includes(c))) return true;
      from = idx + k.length;
    }
  }
  return false;
}

/**
 * Investment-target relevance score (≥2 = keep).
 * Title gold match +3; contextual gold in body +2; macro-driver title +2;
 * macro-driver body with economic context +1; unrelated-sector penalty −4.
 */
/** Generic relevance for product-defined keyword sets (multi-asset). */
function scoreGeneric(item, rel) {
  const title = lower(item?.title);
  const body = lower(item?.description ?? item?.summary ?? '');
  const hay = `${title}\n${body}`;
  const core = (rel.core ?? []).map(lower);
  const ctx = (rel.context ?? []).map(lower);
  const neg = (rel.negative ?? NEG_CTX).map(lower);
  let score = 0;
  if (titleHasAny(title, core)) score += 3;
  for (const k of core) {
    const idx = hay.indexOf(k);
    if (idx === -1) continue;
    const around = hay.slice(Math.max(0, idx - WINDOW), idx + k.length + WINDOW);
    if (ctx.some(c => around.includes(c))) { score += 2; break; }
  }
  if (titleHasAny(title, ctx)) score += 2;
  if (titleHasAny(hay, neg)) score -= 4;
  return score;
}

/**
 * Investment-target relevance score (≥2 = keep).
 * With a product relevance spec ({core, context, negative}) the generic scorer
 * is used; without one the gold-specific rules below apply.
 */
export function scoreRelevance(item, relevance = null) {
  if (relevance) return scoreGeneric(item, relevance);
  const title = lower(item?.title);
  const body = lower(item?.description ?? item?.summary ?? '');
  const hay = `${title}\n${body}`;
  let score = 0;
  if (titleHasAny(title, GOLD_CORE)) {
    // A bare 黄金 anywhere in a title is not enough (黄金周/黄金地段/黄金比例).
    score += titleHasAny(title, INVESTMENT_TITLE) ? 3 : 1;
  }
  if (goldWithContext(body)) score += 2;
  if (titleHasAny(title, MACRO_DRIVER)) score += 2;
  else if (titleHasAny(body, MACRO_DRIVER) && titleHasAny(hay, ECON_CTX)) score += 1;
  if (titleHasAny(hay, NEG_CTX)) score -= 4;
  return score;
}

/** Keep only items relevant to the investment target. */
export function relevant(item, relevance = null) {
  return scoreRelevance(item, relevance) >= 2;
}

/** Title → CJK/alnum bigram set (lowercased, punctuation stripped). */
function titleBigrams(title) {
  const s = String(title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/** Jaccard similarity of two bigram sets (0 when either is empty). */
function bigramJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Numeric tokens in a title (anchors: two stories about different figures differ). */
function numberSet(title) {
  return new Set(String(title ?? '').match(/\d+(?:\.\d+)?/g) ?? []);
}

/**
 * Rank stored news for the decision prompt: investment relevance first, then
 * recency, collapsing syndicated rewrites of ONE story across sources
 * (人民网/中新网/新浪 word the same event differently — an exact 30-char key
 * misses them and they eat the ten prompt slots). Union-find over bigram
 * Jaccard ≥ 0.6: chains merge, template headlines from different companies
 * (茅台 vs 宁德季度业绩) stay apart. Returns items with `score` attached.
 */
export function rankNews(items, nowMs = Date.now(), relevance = null) {
  const ranked = (items ?? [])
    .filter((n) => relevant(n, relevance)) // same gate as ingest: below-threshold items never take a prompt slot
    .map((n) => {
      // Missing/estimated publish time gets no recency credit: an undated
      // first-seen item must not outrank genuinely fresh news.
      const estimated = n.tsEstimated === true || !Number.isFinite(n.ts);
      const ts = estimated ? nowMs : n.ts;
      const ageDays = estimated ? Infinity : Math.max(0, (nowMs - ts) / 86400_000);
      const recency = ageDays <= 1 ? 3 : ageDays <= 3 ? 2 : ageDays <= 7 ? 1 : 0;
      const score = scoreRelevance(n, relevance);
      return { item: { ...n, ts, score, tsEstimated: estimated }, rank: score * 2 + recency };
    })
    // Dated items always outrank estimated ones: an undated item's "first seen"
    // time must never displace news with a verified publish date in the prompt.
    .sort((a, b) => (Number(a.item.tsEstimated) - Number(b.item.tsEstimated))
      || (b.rank - a.rank)
      || (b.item.ts - a.item.ts));

  // Union-find story clustering: keep only the highest-ranked title per
  // story. Two titles merge only when their bigram Jaccard ≥ 0.35 AND their
  // numeric tokens are compatible (both number-less, or sharing a figure):
  // same-event rewrites share "24"/"0.7" while template headlines from
  // different subjects (茅台 vs 宁德 季度业绩) carry different numbers.
  const grams = ranked.map(x => titleBigrams(x.item.title));
  const nums = ranked.map(x => numberSet(x.item.title));
  const numbersOk = (i, j) => {
    if (!nums[i].size && !nums[j].size) return true;
    for (const n of nums[i]) if (nums[j].has(n)) return true;
    return false;
  };
  const parent = ranked.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ranked.length; i += 1) {
    for (let j = i + 1; j < ranked.length; j += 1) {
      if (numbersOk(i, j) && bigramJaccard(grams[i], grams[j]) >= 0.35) parent[find(j)] = find(i);
    }
  }
  const seenRoot = new Set();
  const out = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const root = find(i);
    if (seenRoot.has(root)) continue;
    seenRoot.add(root);
    out.push(ranked[i].item);
  }
  return out;
}

/* ------------------------------ ingestion -------------------------------- */

/**
 * Authoritative, free sources (verified reachable 2026-11-06):
 * - 央行新闻发布: PBoC official announcements (HTML index) — 央行增持黄金等
 * - 中国黄金协会: gold industry stats / 贵金属周报 (HTML index)
 * - 中新网财经: Chinese finance RSS
 * - CNBC Finance: international macro RSS
 * - Kitco News: international gold authority (HTML index)
 */
export const DEFAULT_FEEDS = [
  {
    name: '央行新闻发布', kind: 'html', url: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html',
    spec: {
      linkPattern: /href="(\/goutongjiaoliu\/113456\/113469\/\d+\/index\.html)"[^>]*?\stitle="([^"]+)"/g,
      datePattern: /(\d{4}-\d{2}-\d{2})/g,
      baseUrl: 'https://www.pbc.gov.cn',
    },
  },
  {
    name: '中国黄金协会', kind: 'html', url: 'https://www.cngold.org.cn/',
    spec: {
      // Capture the anchor's inner HTML: covers all three live markup forms
      // (plain anchor text, <div class="t2">+<div class="time">, image cards
      // with a dated /upload/YYYYMM/DD/ path) and yields per-item dates.
      linkPattern: /href="(\/news\/show-\d+\.html)"[^>]*>((?:(?!<\/a>)[\s\S])*?)<\/a>/g,
      inner: true,
      baseUrl: 'https://www.cngold.org.cn',
    },
  },
  {
    name: 'Kitco黄金', kind: 'html', url: 'https://www.kitco.com/news',
    spec: {
      linkPattern: /href="(\/news\/article\/\d{4}-\d{2}-\d{2}\/[^"]+)"(?:(?!<\/a>)[\s\S])*?(?:alt="([^"]+)"|>\s*([^<]{8,140})<\/a>)/g,
      dateFromUrl: /\/(\d{4}-\d{2}-\d{2})\//,
      baseUrl: 'https://www.kitco.com',
    },
  },
  { name: '中新网财经', kind: 'rss', url: 'https://www.chinanews.com.cn/rss/finance.xml' },
  // 人民网财经 removed (2026-11-12 frequency review): 0 rows stored all-time
  // while fetched at every poll — its items never pass the relevance gate.
  { name: 'CNBC财经', kind: 'rss', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
];

/**
 * Fetch and parse all feeds, filter by relevance, upsert into the store.
 * @returns {fetched, kept, stored, bySource}
 */
export async function ingestFeeds(fetchFn, db, cfg, feeds = DEFAULT_FEEDS, timeoutMs = 15000, relevance = null) {
  const maxAgeMs = (cfg.newsMaxAgeDays ?? 60) * 86400_000;
  const nowMs = Date.now();
  // Fetch in parallel: sequential 15s timeouts could stall a decision cycle
  // for ~90s before the LLM prompt is built.
  const perFeed = await Promise.all(feeds.map(async (feed) => {
    const s = { fetched: 0, kept: 0, stored: 0 };
    try {
      const res = await fetchFn(feed.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const text = await res.text();
        const items = feed.kind === 'html'
          ? parseHtmlList(text, feed.spec ?? feed) // product feeds declare the spec inline
          : parseRss(text);
        s.fetched = items.length;
        if (items.length === 0 && text.length > 500) {
          // 200 + parseable page but zero items: most likely selector drift.
          s.warning = 'no items parsed';
        }
        // Same URL can appear in several sections of an index page; prefer the
        // occurrence that carries a real publish date.
        const unique = new Map();
        for (const item of items) {
          if (!item?.link) continue;
          const parsed = Date.parse(item.pubDate);
          const real = Number.isFinite(parsed);
          const prev = unique.get(item.link);
          if (!prev || (prev.estimated && real)) {
            unique.set(item.link, { item, ts: real ? parsed : nowMs, estimated: !real });
          }
        }
        // Undated index items (e.g. cngold list anchors) get their real publish
        // date from the article page — bounded and only for NEW relevant URLs.
        const values = [...unique.values()];
        const candidates = values.filter(e => e.estimated && relevant(e.item, relevance));
        if (candidates.length) {
          const known = new Set((db.latestNews?.(2000, cfg.productId ?? null) ?? []).map(n => n.url));
          const needDate = candidates.filter(e => !known.has(e.item.link)).slice(0, 16);
          if (needDate.length) {
            const resolved = await Promise.all(
              needDate.map(e => resolvePublishTime(fetchFn, e.item.link).catch(() => null)),
            );
            resolved.forEach((dateTs, i) => {
              if (Number.isFinite(dateTs)) { needDate[i].ts = dateTs; needDate[i].estimated = false; }
            });
          }
        }
        for (const { item, ts, estimated } of unique.values()) {
          // Only a real date can prove staleness; an estimate must not be
          // dropped as stale, but it also never earns recency credit later.
          if (!estimated && nowMs - ts > maxAgeMs) continue;
          if (!relevant(item, relevance)) continue;
          s.kept += 1;
          const ok = db.upsertNews({
            ts,
            tsEstimated: estimated,
            source: feed.name,
            title: item.title.slice(0, 300),
            url: item.link,
            summary: (item.description ?? '').slice(0, 500),
            product: cfg.productId ?? 'gold',
          });
          if (ok) s.stored += 1;
        }
      } else {
        s.error = `HTTP ${res.status ?? 'error'}`; // dead feed ≠ empty feed
      }
    } catch (e) {
      // Keep the loop alive; capture the hidden undici cause (ENOTFOUND /
      // ECONNREFUSED / …) — `TypeError: fetch failed` alone is undiagnosable.
      const cause = e?.cause ? ` [${e.cause.code ?? e.cause.message ?? ''}]` : '';
      s.error = `${String(e?.message ?? e)}${cause}`.slice(0, 160);
    }
    return { name: feed.name, s };
  }));
  let fetched = 0;
  let kept = 0;
  let stored = 0;
  const bySource = {};
  for (const { name, s } of perFeed) {
    fetched += s.fetched;
    kept += s.kept;
    stored += s.stored;
    bySource[name] = s;
  }
  return { fetched, kept, stored, bySource };
}

/** Map the harness web-search result ({sources:[{url,title,snippet,summary,publishedAt}]}). */
export function normalizeWebSearch(res) {
  const sources = Array.isArray(res?.sources) ? res.sources
    : Array.isArray(res?.results) ? res.results : [];
  return sources
    .filter(s => s?.url && s?.title)
    .map(s => ({
      title: decodeEntities(String(s.title)),
      url: String(s.url),
      snippet: decodeEntities(String(s.snippet ?? s.summary ?? '')),
      publishedAt: s.publishedAt ?? s.published_at ?? undefined,
    }));
}

/**
 * Web-search enrichment for product queries. Throws only when EVERY query
 * failed — swallowing all errors made `searchError` structurally always-null,
 * so a provider outage was indistinguishable from dedup saturation
 * (frequency review P4).
 */
export function createSearchFn(web) {
  if (!web) return undefined;
  return async (queries) => {
    const items = [];
    let attempted = 0;
    let failed = 0;
    let lastError = null;
    for (const query of queries ?? []) {
      attempted += 1;
      try {
        const res = await web.search({ query, maxResults: 5 });
        items.push(...normalizeWebSearch(res));
      } catch (e) {
        failed += 1;
        lastError = e;
      }
    }
    if (attempted > 0 && failed === attempted && lastError) throw lastError;
    return items;
  };
}

/** Build a timestamp from a month-day (no year), inferring the year: a date
 *  "in the future" by more than 36h must belong to last year (e.g. 12-31 in Jan). */
function withInferredYear(month, day, hh, mm) {
  const shNow = new Date(Date.now() + 8 * 3600_000); // Shanghai wall clock
  const build = (y) => Date.parse(
    `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    + `T${String(hh ?? 0).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')}:00+08:00`,
  );
  const year = shNow.getUTCFullYear();
  let ts = build(year);
  if (!Number.isFinite(ts)) return null;
  if (ts > Date.now() + 36 * 3600_000) ts = build(year - 1);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Best-effort real publish time for an undated item.
 * 1) Date embedded in the URL path (/2026-11-06/, /20261106/, t20261106_).
 * 2) Article page metadata (article:published_time / pubdate / JSON-LD / <time datetime>).
 * 3) Visible date: YYYY-MM-DD…, or a year-less MM-DD inside <time>/date-class markup
 *    (many Chinese portals render only "04-02 15:10").
 * Returns a ms timestamp or null when nothing trustworthy is found.
 */
export async function resolvePublishTime(fetchFn, url, timeoutMs = 6000) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return null;
  const fromUrl = url.match(/\/((?:19|20)\d{2})[-\/]?(\d{2})[-\/]?(\d{2})(?:[\/_\-.]|$)/);
  if (fromUrl) {
    const ts = Date.parse(`${fromUrl[1]}-${fromUrl[2]}-${fromUrl[3]}T00:00:00Z`);
    if (Number.isFinite(ts)) return ts;
  }
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = String(await res.text()).slice(0, 800_000); // long article pages put <time> late
    const candidates = [
      html.match(/article:published_time"\s+content="([^"]+)"/i)?.[1],
      html.match(/property="article:published_time"\s+content="([^"]+)"/i)?.[1],
      html.match(/name="pubdate"\s+content="([^"]+)"/i)?.[1],
      html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1],
      html.match(/itemprop="datePublished"\s+content="([^"]+)"/i)?.[1],
      html.match(/<time[^>]*\sdatetime="([^"]+)"/i)?.[1],
      html.match(/(?:publish_time|pubtime|publishDate|publish_date)"?\s*[:=]\s*"([^"]+)"/i)?.[1],
    ].filter(Boolean);
    for (const c of candidates) {
      const ts = Date.parse(c);
      if (Number.isFinite(ts)) return ts;
    }
    // Visible date with an explicit year, e.g. 2026-11-06 10:30 / 2026年11月6日
    const visible = html.match(/((?:19|20)\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (visible) {
      const [, y, mo, d, hh, mm] = visible;
      const ts = Date.parse(
        `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        + `T${String(hh ?? 0).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')}:00+08:00`,
      );
      if (Number.isFinite(ts)) return ts;
    }
    // Year-less MM-DD inside date-ish markup: <time class="date">04-02 15:10
    const timeTag = html.match(/<time[^>]*>([\s\S]{0,80}?)<\/time>/i)
      ?? html.match(/class="[^"]*(?:date|time|publish)[^"]*"[^>]*>\s*(\d{1,2})[-/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/i);
    if (timeTag) {
      const inner = String(timeTag[1] ?? '');
      const md = inner.match(/(\d{1,2})[-/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
      if (md) {
        const ts = withInferredYear(md[1], md[2], md[3], md[4]);
        if (Number.isFinite(ts)) return ts;
      }
    }
  } catch {
    /* page unreachable: caller keeps the estimated timestamp */
  }
  return null;
}

/**
 * Upgrade already-stored estimated rows with real publish dates. Called every
 * ingest so a backlog of undated items converges instead of staying estimated
 * forever (dedupe would otherwise never retry them).
 * @returns number of rows upgraded
 */
export async function backfillPublishDates(fetchFn, db, limit = 12, cfg = {}) {
  const maxAgeMs = (cfg.newsMaxAgeDays ?? 60) * 86400_000;
  // A URL that keeps failing gets benched after MAX_TRIES attempts instead of
  // being re-fetched on every ingest (frequency review P1: ~4.6k wasted
  // fetches/day retrying the same unresolvable rows).
  const MAX_TRIES = 3;
  const triesKey = `backfillTries:${cfg.productId ?? 'legacy'}`;
  const tries = (db.getState?.(triesKey) ?? {});
  // Scope to this product so one product never upgrades/drops another's rows.
  const estimatedRows = (db.latestNews?.(300, cfg.productId ?? null) ?? [])
    .filter(n => n.tsEstimated && n.url && (tries[n.hash] ?? 0) < MAX_TRIES)
    .slice(0, limit);
  if (!estimatedRows.length) return { upgraded: 0, dropped: 0 };
  const resolved = await Promise.all(
    estimatedRows.map(n => resolvePublishTime(fetchFn, n.url).catch(() => null)),
  );
  let upgraded = 0;
  let dropped = 0;
  let triesChanged = false;
  resolved.forEach((ts, i) => {
    const row = estimatedRows[i];
    if (!Number.isFinite(ts)) {
      tries[row.hash] = (tries[row.hash] ?? 0) + 1; // count the failed attempt
      triesChanged = true;
      return;
    }
    // A real date that proves the item stale removes it instead of upgrading:
    // otherwise old articles keep occupying the "latest news" feed.
    if (Date.now() - ts > maxAgeMs) {
      db.removeNews(row.hash);
      dropped += 1;
      delete tries[row.hash];
      triesChanged = true;
      return;
    }
    const changed = db.upsertNews({
      ts,
      tsEstimated: false,
      source: row.source,
      title: row.title,
      url: row.url,
      summary: row.summary ?? '',
    });
    // upsertNews returns false for existing rows; it upgrades the estimate in place.
    if (!changed) upgraded += 1;
    delete tries[row.hash];
    triesChanged = true;
  });
  if (triesChanged) {
    const keys = Object.keys(tries);
    if (keys.length > 1000) for (const k of keys.slice(0, keys.length - 1000)) delete tries[k];
    db.putState?.(triesKey, tries);
  }
  return { upgraded, dropped };
}

/** Store web-search results ({title, url, snippet, publishedAt}) as news items. */
export async function ingestSearchResults(fetchFn, db, results, source = 'web-search', cfg = {}, relevance = null) {
  const maxAgeMs = (cfg.newsMaxAgeDays ?? 60) * 86400_000;
  const nowMs = Date.now();
  let stored = 0;
  const known = new Set((db.latestNews?.(2000, cfg.productId ?? null) ?? []).map(n => n.url));
  const entries = [];
  for (const r of results ?? []) {
    if (!r?.url || !r?.title) continue;
    // Quote/overview aggregator pages are not news: they carry the stock name
    // and score highly while telling us nothing.
    if (/个股概览|实时行情|股票价格|走势图|行情中心|股票行情|报价中心|F10资料/.test(String(r.title))) continue;
    const item = { title: String(r.title), description: String(r.snippet ?? r.summary ?? '') };
    if (!relevant(item, relevance)) continue;
    const parsed = Date.parse(r.publishedAt);
    entries.push({ item, url: r.url, ts: Number.isFinite(parsed) ? parsed : null, estimated: !Number.isFinite(parsed) });
  }
  // Resolve real publish dates for undated NEW results (bounded, in parallel).
  const needDate = entries.filter(e => e.estimated && !known.has(e.url)).slice(0, 12);
  if (needDate.length) {
    const resolved = await Promise.all(needDate.map(e => resolvePublishTime(fetchFn, e.url).catch(() => null)));
    resolved.forEach((ts, i) => {
      if (Number.isFinite(ts)) { needDate[i].ts = ts; needDate[i].estimated = false; }
    });
  }
  for (const e of entries) {
    const estimated = e.estimated;
    const ts = estimated ? nowMs : e.ts;
    if (!estimated && nowMs - ts > maxAgeMs) continue; // drop stale search results too
    const ok = db.upsertNews({
      ts,
      tsEstimated: estimated,
      source,
      title: e.item.title.slice(0, 300),
      url: e.url,
      summary: e.item.description.slice(0, 500),
      product: cfg.productId ?? 'gold',
    });
    if (ok) stored += 1;
  }
  return stored;
}
