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
  const items = [];
  const dates = [];
  if (spec.datePattern) {
    for (const m of html.matchAll(new RegExp(spec.datePattern.source, 'g'))) dates.push(m[1]);
  }
  let i = 0;
  for (const m of html.matchAll(new RegExp(spec.linkPattern.source, 'g'))) {
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
export function scoreRelevance(item) {
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

/** Keep only items relevant to the investment target (gold). */
export function relevant(item) {
  return scoreRelevance(item) >= 2;
}

/**
 * Rank stored news for the decision prompt: investment relevance first, then
 * recency, dropping near-identical titles (the same story syndicated across
 * 人民网/中新网 otherwise eats several of the ten prompt slots).
 * Returns items with `score` attached for display.
 */
export function rankNews(items, nowMs = Date.now()) {
  const seen = new Set();
  return (items ?? [])
    .filter((n) => relevant(n)) // same gate as ingest: below-threshold items never take a prompt slot
    .map((n) => {
      // Missing/estimated publish time gets no recency credit: an undated
      // first-seen item must not outrank genuinely fresh news.
      const estimated = n.tsEstimated === true || !Number.isFinite(n.ts);
      const ts = estimated ? nowMs : n.ts;
      const ageDays = estimated ? Infinity : Math.max(0, (nowMs - ts) / 86400_000);
      const recency = ageDays <= 1 ? 3 : ageDays <= 3 ? 2 : ageDays <= 7 ? 1 : 0;
      const score = scoreRelevance(n);
      const key = String(n.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 30);
      return { item: { ...n, ts, score, tsEstimated: estimated }, rank: score * 2 + recency, key };
    })
    .sort((a, b) => b.rank - a.rank || b.item.ts - a.item.ts)
    .filter((x) => {
      if (x.key && seen.has(x.key)) return false;
      if (x.key) seen.add(x.key);
      return true;
    })
    .map((x) => x.item);
}

/* ------------------------------ ingestion -------------------------------- */

/**
 * Authoritative, free sources (verified reachable 2026-11-06):
 * - 央行新闻发布: PBoC official announcements (HTML index) — 央行增持黄金等
 * - 中国黄金协会: gold industry stats / 贵金属周报 (HTML index)
 * - 中新网财经 / 人民网财经: Chinese finance RSS
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
  { name: '人民网财经', kind: 'rss', url: 'http://www.people.com.cn/rss/finance.xml' },
  { name: 'CNBC财经', kind: 'rss', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
];

/**
 * Fetch and parse all feeds, filter by relevance, upsert into the store.
 * @returns {fetched, kept, stored, bySource}
 */
export async function ingestFeeds(fetchFn, db, cfg, feeds = DEFAULT_FEEDS, timeoutMs = 15000) {
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
          ? parseHtmlList(text, feed.spec)
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
        const candidates = values.filter(e => e.estimated && relevant(e.item));
        if (candidates.length) {
          const known = new Set((db.latestNews?.(2000) ?? []).map(n => n.url));
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
          if (!relevant(item)) continue;
          s.kept += 1;
          const ok = db.upsertNews({
            ts,
            tsEstimated: estimated,
            source: feed.name,
            title: item.title.slice(0, 300),
            url: item.link,
            summary: (item.description ?? '').slice(0, 500),
          });
          if (ok) s.stored += 1;
        }
      } else {
        s.error = `HTTP ${res.status ?? 'error'}`; // dead feed ≠ empty feed
      }
    } catch (e) {
      s.error = String(e?.message ?? e).slice(0, 120); // keep the loop alive
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
 * Best-effort real publish time for an undated item.
 * 1) Date embedded in the URL path (/2026-11-06/, /20261106/, t20261106_).
 * 2) Article page metadata (article:published_time, pubdate, JSON-LD, visible date).
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
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const html = String(await res.text()).slice(0, 200_000);
    const candidates = [
      html.match(/article:published_time"\s+content="([^"]+)"/i)?.[1],
      html.match(/property="article:published_time"\s+content="([^"]+)"/i)?.[1],
      html.match(/name="pubdate"\s+content="([^"]+)"/i)?.[1],
      html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1],
    ].filter(Boolean);
    for (const c of candidates) {
      const ts = Date.parse(c);
      if (Number.isFinite(ts)) return ts;
    }
    // Visible Chinese date, e.g. 2026-11-06 10:30 / 2026年11月6日
    const visible = html.match(/((?:19|20)\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
    if (visible) {
      const [, y, mo, d, hh, mm] = visible;
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` +
        `${hh ? `T${String(hh).padStart(2, '0')}:${mm}:00` : ''}`;
      const ts = Date.parse(iso);
      if (Number.isFinite(ts)) return ts;
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
export async function backfillPublishDates(fetchFn, db, limit = 12) {
  const estimatedRows = (db.latestNews?.(300) ?? [])
    .filter(n => n.tsEstimated && n.url)
    .slice(0, limit);
  if (!estimatedRows.length) return 0;
  const resolved = await Promise.all(
    estimatedRows.map(n => resolvePublishTime(fetchFn, n.url).catch(() => null)),
  );
  let upgraded = 0;
  resolved.forEach((ts, i) => {
    if (!Number.isFinite(ts)) return;
    const row = estimatedRows[i];
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
  });
  return upgraded;
}

/** Store web-search results ({title, url, snippet, publishedAt}) as news items. */
export async function ingestSearchResults(fetchFn, db, results, source = 'web-search', cfg = {}) {
  const maxAgeMs = (cfg.newsMaxAgeDays ?? 60) * 86400_000;
  const nowMs = Date.now();
  let stored = 0;
  const known = new Set((db.latestNews?.(2000) ?? []).map(n => n.url));
  const entries = [];
  for (const r of results ?? []) {
    if (!r?.url || !r?.title) continue;
    const item = { title: String(r.title), description: String(r.snippet ?? r.summary ?? '') };
    if (!relevant(item)) continue;
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
    });
    if (ok) stored += 1;
  }
  return stored;
}
