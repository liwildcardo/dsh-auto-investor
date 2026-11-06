import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, scoreRelevance, relevant, parseHtmlList, extractText, ingestFeeds, normalizeWebSearch, decodeEntities } from '../lib/news.js';

// ---------- relevance scoring (issue: unrelated news leaking in) ----------

test('rejects false-positive 黄金 matches like 黄金菌群 (dairy)', () => {
  const item = {
    title: '体育精神赋能 乳制品行业推动品质提升',
    description: '君乐宝发布了新品发布会。专家表示，君乐宝培育出了黄金菌群组合，建成了拥有1000余株优质乳酸菌的菌种保藏中心。',
  };
  assert.equal(relevant(item), false);
  assert.ok(scoreRelevance(item) < 2);
});

test('rejects lifestyle/tech news with no gold driver', () => {
  const phone = { title: '买卖二手手机，如何更安心', description: '黄金周促销期间，手机折抵800元。' };
  assert.equal(relevant(phone), false);
  const rice = { title: '一粒稻谷上演“七十二变”', description: '稻壳灰提取硬碳材料，稻米油被誉为液体黄金。' };
  assert.equal(relevant(rice), false);
});

test('rejects 黄金 substring junk (week/land/ratio/partner/jewelry/prime-time)', () => {
  const cases = [
    { title: '国庆黄金周旅游消费创新高', description: '假期出行人次破亿。' },
    { title: '黄金地段商铺租金上涨', description: '核心商圈一铺难求。' },
    { title: '黄金比例身材养成指南', description: '健身饮食计划。' },
    { title: '黄金搭档再创销售纪录', description: '品牌联名新品。' },
    { title: '黄金饰品店开业大促', description: '门店促销活动。' },
    { title: '黄金时段广告涨价', description: '电视台广告部消息。' },
  ];
  for (const c of cases) {
    assert.equal(relevant(c), false, `should reject: ${c.title}`);
    assert.ok(scoreRelevance(c) < 2, `score too high for ${c.title}: ${scoreRelevance(c)}`);
  }
  // same failure class in the real cngold feed
  assert.equal(relevant({ title: '刘小明会见中国黄金协会党委书记严弟勇', description: '协会动态。' }), false);
  assert.equal(relevant({ title: '紫金矿业向巴青灾区捐赠1000万元', description: '矿山救援队连夜奔抵震区。' }), false);
});

test('keeps gold news with an investment signal in the title', () => {
  const cases = [
    { title: '金价突破4000美元', description: '市场走强。' },
    { title: '央行连续12个月增持黄金储备', description: '外汇局公布数据。' },
    { title: '黄金ETF持仓创三个月新高', description: '资金持续流入。' },
    { title: '伦敦金现涨1.2%', description: '盘中走强。' },
    { title: '2025年12月，我国增持黄金0.93吨', description: '黄金统计。' },
    { title: '贵金属周报674期', description: '黄金市场周度分析。' },
    { title: 'World Bank sees gold holding above $4,000', description: 'Gold prices stay elevated.' },
  ];
  for (const c of cases) {
    assert.equal(relevant(c), true, `should keep: ${c.title}`);
  }
});

test('keeps core gold news (title match)', () => {
  assert.equal(relevant({ title: '央行连续12个月增持黄金储备', description: '外汇局公布数据。' }), true);
  assert.equal(relevant({ title: 'World Bank sees gold holding above $4,000', description: 'Gold prices stay elevated.' }), true);
  assert.equal(relevant({ title: '2025年12月，我国增持黄金0.93吨', description: '黄金统计。' }), true);
  assert.equal(relevant({ title: '贵金属周报674期', description: '黄金市场周度分析。' }), true);
});

test('keeps strong macro-driver news affecting gold', () => {
  assert.equal(relevant({ title: '美联储议息会议临近', description: '市场关注利率走向。' }), true);
  assert.equal(relevant({ title: 'Fed holds rates steady despite concerns over inflation', description: 'Two of the 12 FOMC voters dissented.' }), true);
  assert.equal(relevant({ title: '央行开展2260亿元隔夜逆回购操作', description: '满足一级交易商需求。' }), true);
});

test('macro-only description without economic context is weak', () => {
  const item = { title: '某地举办文化节', description: '文旅市场回暖，利率与投资话题偶被提及。' };
  assert.equal(relevant(item), false);
});

test('scoreRelevance is deterministic and bounded', () => {
  const a = scoreRelevance({ title: '黄金价格大涨', description: '金价突破。' });
  const b = scoreRelevance({ title: '黄金价格大涨', description: '金价突破。' });
  assert.equal(a, b);
  assert.ok(a >= 2);
});

// ---------- RSS parsing (regression) ----------

test('parseRss still extracts items', () => {
  const xml = '<rss><channel><item><title>央行增持黄金</title><link>http://x/1</link><description>d</description></item></channel></rss>';
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '央行增持黄金');
});

// ---------- HTML list parsing (new source type) ----------

test('parseHtmlList extracts PBoC-style title links with dates', () => {
  const html = `
    <a href="/goutongjiaoliu/113456/113469/2026110516262373524/index.html" title="中国人民银行决定上调外汇存款准备金率" istitle="true">x</a>
    <span class="hui12">2026-11-05</span>
    <a href="/goutongjiaoliu/113456/113469/2026110408502315269/index.html" title="中国人民银行加力实施股票回购增持再贷款政策" istitle="true">y</a>
    <span class="hui12">2026-11-04</span>`;
  const items = parseHtmlList(html, {
    linkPattern: /href="(\/goutongjiaoliu\/113456\/113469\/\d+\/index\.html)"[^>]*?\stitle="([^"]+)"/g,
    datePattern: /(\d{4}-\d{2}-\d{2})/g,
    baseUrl: 'https://www.pbc.gov.cn',
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '中国人民银行决定上调外汇存款准备金率');
  assert.ok(items[0].link.startsWith('https://www.pbc.gov.cn/'));
  assert.equal(items[0].pubDate, '2026-11-05');
});

test('parseHtmlList extracts cngold-style anchor text links', () => {
  const html = `<li><a href="/news/show-9609.html">贵金属周报674期</a></li>
    <li><a href="/news/show-8882.html">2025年12月，我国增持黄金0.93吨</a></li>`;
  const items = parseHtmlList(html, {
    linkPattern: /href="(\/news\/show-\d+\.html)"[^>]*>\s*([^<]{4,80})<\/a>/g,
    baseUrl: 'https://www.cngold.org.cn',
  });
  assert.equal(items.length, 2);
  assert.equal(items[1].title, '2025年12月，我国增持黄金0.93吨');
  assert.ok(items[1].link.includes('show-8882'));
});

test('parseHtmlList extracts Kitco img-alt teaser links', () => {
  const html = `
    <a href="/news/article/2026-11-05/gold-climbs-above-4100" class="teaser">
      <img alt="Gold climbs above $4,100 as yields fall" src="/x.jpg"/>
    </a>
    <a href="/news/article/2026-11-04/world-bank-gold">World Bank sees gold above $4,000</a>`;
  const items = parseHtmlList(html, {
    linkPattern: /href="(\/news\/article\/\d{4}-\d{2}-\d{2}\/[^"]+)"[^>]*>[\s\S]*?(?:alt="([^"]+)"|>\s*([^<]{8,140})<\/a>)/g,
    baseUrl: 'https://www.kitco.com',
  });
  assert.ok(items.length >= 1, `items=${items.length}`);
  assert.match(items[0].title, /\$4,100|\$4,000|gold/i);
});

test('stale RSS items are skipped by ingestFeeds', async () => {
  const old = new Date(Date.now() - 400 * 24 * 3600_000).toUTCString();
  const xml = `<rss><channel>
    <item><title>黄金价格上涨</title><link>https://x/old</link><description>金价</description><pubDate>${old}</pubDate></item>
  </channel></rss>`;
  const store = { items: [], upsertNews(i) { this.items.push(i); return true; } };
  const cfg = { newsMaxAgeDays: 60 };
  const fetchFn = async () => ({ ok: true, text: async () => xml });
  const feeds = [{ name: 't', kind: 'rss', url: 'https://x/feed' }];
  const res = await ingestFeeds(fetchFn, store, cfg, feeds);
  assert.equal(res.fetched, 1);
  assert.equal(res.stored, 0, 'stale item must be dropped');
});

test('normalizeWebSearch maps harness sources to items', () => {
  const out = normalizeWebSearch({
    sources: [{ url: 'https://a', title: '央行增持黄金', snippet: 's', publishedAt: '2026-11-05T00:00:00Z' }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://a');
  assert.equal(out[0].title, '央行增持黄金');
  assert.ok(out[0].publishedAt);
});

test('parseHtmlList tolerates garbage', () => {
  assert.deepEqual(parseHtmlList('no links', { linkPattern: /href="(x)"/g }), []);
});

test('extractText unchanged', () => {
  assert.equal(extractText('<p>你好 <b>世界</b></p>'), '你好 世界');
});

test('decodeEntities resolves named and numeric entities in titles', () => {
  assert.equal(decodeEntities('Gold&#x27;s &apos;rally&apos; &amp; yields'), "Gold's 'rally' & yields");
  assert.equal(extractText('&#x27;金价&#x27; &amp; 走势'), "'金价' & 走势");
  const [item] = normalizeWebSearch({ sources: [{ url: 'https://a', title: 'Gold&#x27;s rise', snippet: 'a&nbsp;b' }] });
  assert.equal(item.title, "Gold's rise");
  assert.equal(item.snippet, 'a b');
});
