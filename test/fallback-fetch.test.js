import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptWebFetchResult, makeRoutingFetch } from '../lib/fallback-fetch.js';

test('adaptWebFetchResult accepts every plausible web.fetch shape', async () => {
  const cases = [
    ['plain string', 'hello', 'hello'],
    ['{text}', { text: 'aaa' }, 'aaa'],
    ['{content}', { content: 'bbb' }, 'bbb'],
    ['{body}', { body: 'ccc' }, 'ccc'],
    ['{data}', { data: 'ddd' }, 'ddd'],
  ];
  for (const [label, input, expected] of cases) {
    const r = adaptWebFetchResult(input);
    assert.equal(r.ok, true, label);
    assert.equal(await r.text(), expected, label);
  }
  const r = adaptWebFetchResult('{"a":1}');
  assert.deepEqual(await r.json(), { a: 1 });
});

test('adaptWebFetchResult surfaces the actual shape on a mismatch', () => {
  assert.throws(() => adaptWebFetchResult({ weird: 1, other: 2 }), /unexpected shape: \[weird, other\]/);
});

test('routing fetch prefers web.fetch for matched URLs and falls back on errors', async () => {
  const calls = [];
  const baseFetch = async (url) => { calls.push(`base:${url}`); return { ok: true, text: async () => 'from-base' }; };
  const web = { fetch: async ({ url }) => { calls.push(`web:${url}`); return 'from-web'; } };
  const routing = makeRoutingFetch(baseFetch, web);

  // Matched URL → web path with adaptation.
  const r1 = await routing('https://fred.stlouisfed.org/graph/fredgraph.csv?id=X');
  assert.equal(await r1.text(), 'from-web');
  assert.deepEqual(calls, ['web:https://fred.stlouisfed.org/graph/fredgraph.csv?id=X']);

  // Non-matched URL → direct path only.
  calls.length = 0;
  const r2 = await routing('https://open.er-api.com/v6/latest/USD');
  assert.equal(await r2.text(), 'from-base');
  assert.deepEqual(calls, ['base:https://open.er-api.com/v6/latest/USD']);

  // web.fetch throws → falls back to the direct fetch.
  calls.length = 0;
  const badWeb = { fetch: async () => { throw new Error('boom'); } };
  const routing2 = makeRoutingFetch(baseFetch, badWeb);
  const r3 = await routing2('https://fred.stlouisfed.org/x');
  assert.equal(await r3.text(), 'from-base');
  assert.deepEqual(calls, ['base:https://fred.stlouisfed.org/x']);
});

test('routing fetch times out a hanging web.fetch and falls back', async () => {
  const baseFetch = async () => ({ ok: true, text: async () => 'base-rescued' });
  const web = { fetch: () => new Promise(() => {}) }; // hangs forever
  const routing = makeRoutingFetch(baseFetch, web, { timeoutMs: 50 });
  const r = await routing('https://fred.stlouisfed.org/slow');
  assert.equal(await r.text(), 'base-rescued', 'timeout → direct fetch fallback');
});

test('no web service → everything goes direct', async () => {
  const baseFetch = async () => ({ ok: true, text: async () => 'direct' });
  const routing = makeRoutingFetch(baseFetch, null);
  const r = await routing('https://fred.stlouisfed.org/x');
  assert.equal(await r.text(), 'direct');
});
