/**
 * HTTP API on the shared connection fetch channel (same-origin with the GUI):
 *   GET  /api/auto-investor/products          product list
 *   GET  /api/auto-investor/state?product=    full dashboard state
 *   GET  /api/auto-investor/news?product=     recent news
 *   GET  /api/auto-investor/trades?product=   recent trades
 *   GET  /api/auto-investor/strategies?product= strategy versions
 *   POST /api/auto-investor/action            {kind:'run'|'reflect'|'pause'|'resume', product?}
 *
 * Direct trade execution is intentionally absent: the user controls analysis
 * and the loop, never individual orders (trades are the strategy's output).
 */
const BASE = '/api/auto-investor';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function registerRoutes(ctx, service, state) {
  const isHub = typeof service?.products === 'function';
  const urlOf = (request) => {
    try { return new URL(request?.url ?? 'http://local/'); } catch { return new URL('http://local/'); }
  };
  const pidOf = (url, body) => url.searchParams.get('product') ?? body?.product ?? undefined;
  const known = () => (isHub ? service.products().map(p => p.id) : []);
  const rejectUnknown = (pid) => {
    if (!isHub || pid == null) return null;
    return known().includes(pid) ? null : json({ ok: false, reason: `unknown product: ${pid}` }, 400);
  };

  const routes = [
    [`${BASE}/products`, ['GET'], async () => json({ products: isHub ? service.products() : [] })],
    [`${BASE}/state`, ['GET'], async (request) => {
      const url = urlOf(request);
      const pid = isHub ? pidOf(url) : undefined;
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      const symbol = url.searchParams.get('symbol') ?? undefined;
      return json({ ...(isHub ? service.status(pid, symbol) : service.status()), lastRun: state.lastRun });
    }],
    [`${BASE}/news`, ['GET'], async (request) => {
      const url = urlOf(request);
      const pid = isHub ? pidOf(url) : undefined;
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      const limit = Number(url.searchParams.get('limit')) || 20;
      return json({ news: isHub ? service.newsList(pid, limit) : service.newsList(limit) });
    }],
    [`${BASE}/trades`, ['GET'], async (request) => {
      const url = urlOf(request);
      const pid = isHub ? pidOf(url) : undefined;
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      return json({ trades: isHub ? service.trades(pid, 20) : service.tradesList() });
    }],
    [`${BASE}/strategies`, ['GET'], async (request) => {
      const url = urlOf(request);
      const pid = isHub ? pidOf(url) : undefined;
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      if (!isHub) return json({ versions: service.versions, current: service.status().currentVersion });
      return json({ versions: service.versions(pid), current: service.status(pid).currentVersion });
    }],
    [`${BASE}/watchlist`, ['GET'], async (request) => {
      const url = urlOf(request);
      const pid = isHub ? pidOf(url) : undefined;
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      if (!isHub) return json({ watchlist: [] });
      return json({ watchlist: service.watchlist(pid) });
    }],
    [`${BASE}/watchlist`, ['POST'], async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, reason: 'invalid JSON body' }, 400);
      }
      const bad = rejectUnknown(body?.product);
      if (bad) return bad;
      if (!isHub) return json({ ok: false, reason: 'watchlist requires the multi-product hub' }, 400);
      const result = service.watchlistAction(body?.product, body ?? {});
      return json(result, result.ok === false ? 400 : 200);
    }],
    [`${BASE}/search`, ['GET'], async (request) => {
      const url = urlOf(request);
      const pid = isHub ? pidOf(url) : undefined;
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      const q = url.searchParams.get('q') ?? '';
      if (!isHub) return json({ results: [] });
      try {
        return json({ results: await service.search(pid, q) });
      } catch (e) {
        return json({ results: [], error: String(e?.message ?? e) });
      }
    }],
    [`${BASE}/action`, ['POST'], async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, reason: 'invalid JSON body' }, 400);
      }
      const pid = pidOf(urlOf(request), body);
      const bad = rejectUnknown(pid);
      if (bad) return bad;
      switch (body?.kind) {
        case 'run': {
          const result = isHub ? await service.runCycle(pid) : await service.runCycle();
          state.lastRun = Date.now();
          return json({ ok: true, result });
        }
        case 'pause':
          isHub ? service.pause(pid, true) : service.pause(true);
          return json({ ok: true, paused: true, product: pid ?? null });
        case 'resume':
          isHub ? service.pause(pid, false) : service.resume();
          return json({ ok: true, paused: false, product: pid ?? null });
        case 'reflect': {
          const result = isHub ? await service.reflectIfDue(pid, { force: true }) : await service.reflectIfDue({ force: true });
          return json({ ok: true, result });
        }
        default:
          return json({ ok: false, reason: `unknown action kind: ${body?.kind}` }, 400);
      }
    }],
  ];

  const disposers = routes.map(([path, methods, fetch]) =>
    ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }));
  return () => { for (const d of disposers) d(); };
}
