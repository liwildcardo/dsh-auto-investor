/**
 * 进程内数据源探测：用生产 fetchFn（含 web 路由）逐源验证"可达 + 可解析"，
 * 输出 go/no-go 报告。独立 node 脚本拿不到插件进程内的 web 服务，
 * 因此探测必须跑在这里（评审 Q7 决策）。
 *
 * 约定：单源失败不阻塞其他源；detail 保留原始错误（含 web/direct 双路径
 * 信息，如 `web: timeout | direct: ECONNREFUSED`）；check 返回 null = 通过。
 */
const UA = { 'user-agent': 'Mozilla/5.0' };
// 东财类需 referer，与 factor-sources.js 的抓取头一致。
const EM_HEADERS = { ...UA, referer: 'https://quote.eastmoney.com/' };
const QQ_HEADERS = { ...UA, referer: 'https://gu.qq.com/' };

const emQuote = (secid) =>
  `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f86,f58`;

const checkEmQuote = (text) =>
  (Number.isFinite(JSON.parse(text)?.data?.f43) ? null : 'f43 missing');
const checkPrice = (text) =>
  (JSON.parse(text)?.price > 0 ? null : 'price missing');

/** 探针清单：id 稳定（报告/测试按 id 断言），url/check 为各源最小可解析载荷。 */
export const PROBES = [
  {
    id: 'em-ui10y',
    label: '东财 美国10Y通胀挂钩收益率(TIPS)',
    url: emQuote('171.UI10Y'),
    headers: EM_HEADERS,
    check: checkEmQuote,
  },
  {
    id: 'em-us10y',
    label: '东财 美国10Y名义收益率',
    url: emQuote('171.US10Y'),
    headers: EM_HEADERS,
    check: checkEmQuote,
  },
  {
    id: 'em-us02y',
    label: '东财 美国2Y名义收益率',
    url: emQuote('171.US02Y'),
    headers: EM_HEADERS,
    check: checkEmQuote,
  },
  {
    id: 'em-au9999',
    label: '东财 沪金AU9999日K(黄金日线种子源)',
    url: 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=101&fqt=0&beg=20260101&end=20991231',
    headers: EM_HEADERS,
    check: (text) => ((JSON.parse(text)?.data?.klines ?? []).length > 0 ? null : 'klines empty'),
  },
  {
    id: 'gold-xau',
    label: 'gold-api 现货金 XAU',
    url: 'https://api.gold-api.com/price/XAU',
    headers: UA,
    check: checkPrice,
  },
  {
    id: 'gold-xag',
    label: 'gold-api 现货银 XAG',
    url: 'https://api.gold-api.com/price/XAG',
    headers: UA,
    check: checkPrice,
  },
  {
    id: 'erapi-fx',
    label: 'er-api 汇率 USDCNY',
    url: 'https://open.er-api.com/v6/latest/USD',
    headers: UA,
    check: (text) => (Number.isFinite(JSON.parse(text)?.rates?.CNY) ? null : 'CNY missing'),
  },
  {
    id: 'tencent-quote',
    label: '腾讯实时报价',
    url: 'https://qt.gtimg.cn/q=sh000001',
    headers: QQ_HEADERS,
    check: (text) => (/v_sh000001="/.test(text) ? null : 'payload missing'),
  },
  {
    id: 'ifzq-week',
    label: '腾讯周K历史',
    url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,week,,,50,qfq',
    headers: QQ_HEADERS,
    check: (text) => (JSON.parse(text)?.data ? null : 'data missing'),
  },
];

/** Probe one source; never throws — failures become {ok:false, detail}. */
async function probeOne(fetchFn, p) {
  const start = Date.now();
  const base = { id: p.id, label: p.label, url: p.url };
  try {
    const res = await fetchFn(p.url, {
      signal: AbortSignal.timeout(10_000),
      headers: p.headers ?? UA,
    });
    if (!res?.ok) throw new Error(`http ${res?.status ?? 'no-response'}`);
    const err = p.check(await res.text());
    if (err) return { ...base, ok: false, detail: err, ms: Date.now() - start };
    return { ...base, ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ...base, ok: false, detail: String(e?.message ?? e).slice(0, 160), ms: Date.now() - start };
  }
}

/**
 * Run every probe concurrently. Returns
 * {at, results: [{id,label,url,ok,detail?,ms}], summary:{ok,failed}}.
 * No fetchFn (unconfigured service) → empty report, not an error.
 */
export async function probePipelines(fetchFn, now = () => Date.now()) {
  if (typeof fetchFn !== 'function') {
    return { at: now(), results: [], summary: { ok: 0, failed: 0 } };
  }
  const results = await Promise.all(PROBES.map((p) => probeOne(fetchFn, p)));
  const failed = results.filter((r) => !r.ok).length;
  return { at: now(), results, summary: { ok: results.length - failed, failed } };
}
