/**
 * 路由式 fetch：某些源在插件的 globalThis.fetch 下会挂起（实测
 * fred.stlouisfed.org 在宿主内 28–30s 停滞），而 harness 的 web 服务
 * （同进程）可达（web_fetch 工具实测下载成功）。对匹配的 URL 优先走
 * web.fetch，超时/异常时回退到直接 fetch。
 */

/** Adapt a web.fetch result (string or {text|content|body|data}) to a Response-like object. */
export function adaptWebFetchResult(r) {
  const text = typeof r === 'string' ? r
    : typeof r?.text === 'string' ? r.text
      : typeof r?.content === 'string' ? r.content
        : typeof r?.body === 'string' ? r.body
          : typeof r?.data === 'string' ? r.data
            : null;
  if (text == null) {
    // Surface the actual shape once so a contract mismatch is diagnosable.
    throw new Error(`web.fetch unexpected shape: [${Object.keys(r ?? {}).join(', ')}]`);
  }
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
}

/**
 * @param baseFetch the direct fetch (globalThis.fetch)
 * @param web       the harness web service (ctx.get('web')) or null
 * @param match     substring (or array of) URLs that should prefer web.fetch
 */
export function makeRoutingFetch(baseFetch, web, {
  timeoutMs = 30_000,
  match = ['fred.stlouisfed.org', 'push2.eastmoney.com'],
} = {}) {
  const patterns = Array.isArray(match) ? match : [match];
  return async (url, opts) => {
    const u = String(url);
    const matched = patterns.some(p => u.includes(p));
    let webErr = null;
    if (matched && typeof web?.fetch === 'function') {
      let timer;
      try {
        // fetchReady gates some providers; treat false as "path unavailable".
        const ready = typeof web.fetchReady === 'function'
          ? await Promise.resolve(web.fetchReady()).catch(() => null)
          : null;
        if (ready === false) throw new Error('web.fetchReady=false');
        const attempt = Promise.resolve()
          .then(() => web.fetch({ url: u }))
          .then(adaptWebFetchResult);
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('web.fetch timeout')), timeoutMs);
        });
        return await Promise.race([attempt, timeout]);
      } catch (e) {
        webErr = String(e?.message ?? e).slice(0, 160);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      return await baseFetch(url, opts);
    } catch (be) {
      // Surface WHY the preferred path failed — a silent fallback hides the
      // real contract/ready problem behind the base-fetch error.
      const direct = String(be?.message ?? be).slice(0, 160);
      throw new Error(webErr ? `web: ${webErr} | direct: ${direct}` : direct);
    }
  };
}
