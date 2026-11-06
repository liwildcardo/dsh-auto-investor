/**
 * HTTP API on the shared connection fetch channel (same-origin with the GUI):
 *   GET  /api/auto-investor/state     full dashboard state
 *   GET  /api/auto-investor/news      recent news
 *   GET  /api/auto-investor/trades    recent trades
 *   GET  /api/auto-investor/strategies strategy versions
 *   POST /api/auto-investor/action    {kind: 'run'|'reflect'|'pause'|'resume'}
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
  const routes = [
    [`${BASE}/state`, ['GET'], async () => json({ ...service.status(), lastRun: state.lastRun })],
    [`${BASE}/news`, ['GET'], async () => json({ news: service.newsList() })],
    [`${BASE}/trades`, ['GET'], async () => json({ trades: service.tradesList() })],
    [`${BASE}/strategies`, ['GET'], async () => json({ versions: service.versions, current: service.status().currentVersion })],
    [`${BASE}/action`, ['POST'], async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, reason: 'invalid JSON body' }, 400);
      }
      switch (body?.kind) {
        case 'run': {
          const result = await service.runCycle();
          state.lastRun = Date.now();
          return json({ ok: true, result });
        }
        case 'pause':
          service.pause();
          return json({ ok: true, paused: true });
        case 'resume':
          service.resume();
          return json({ ok: true, paused: false });
        case 'reflect': {
          const result = await service.reflectIfDue({ force: true });
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
