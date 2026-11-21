import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteFrom, parseGoldApi, parseFxApi, computeChange } from '../lib/market.js';

test('quoteFrom applies 5元/克 spread around mid', () => {
  const q = quoteFrom(4085.12, 6.685421, 5.0, 31.1035);
  assert.ok(Math.abs((q.buy - q.sell) - 5.0) < 1e-9);
  assert.ok(Math.abs((q.buy + q.sell) / 2 - q.mid) < 1e-9);
});

test('screenshot vector: mid 848.51 => buy 851.01 / sell 846.01', () => {
  // back out xau*fx consistent with mid 848.51
  const mid = 848.51;
  const xauUsd = 3727.46; // any consistent pair
  const usdCny = mid * 31.1035 / xauUsd;
  const q = quoteFrom(xauUsd, usdCny, 5.0, 31.1035);
  assert.ok(Math.abs(q.buy - 851.01) < 0.01, `buy=${q.buy}`);
  assert.ok(Math.abs(q.sell - 846.01) < 0.01, `sell=${q.sell}`);
});

test('USD/oz to 元/克 conversion uses 31.1035 g/oz', () => {
  const q = quoteFrom(4090.0, 6.685421, 0, 31.1035);
  const expected = 4090.0 * 6.685421 / 31.1035;
  // mid is quoted to 2 decimals (money), so allow rounding
  assert.ok(Math.abs(q.mid - expected) < 0.005, `mid=${q.mid} expected=${expected}`);
});

test('parseGoldApi reads live payload shape', () => {
  const v = parseGoldApi({ currency: 'USD', name: 'Gold', price: 4090.0, symbol: 'XAU', updatedAt: '2026-11-05T23:48:33Z' });
  assert.equal(v, 4090.0);
});

test('parseGoldApi rejects garbage', () => {
  assert.equal(parseGoldApi(null), null);
  assert.equal(parseGoldApi({ price: 'x' }), null);
  assert.equal(parseGoldApi({}), null);
});

test('parseFxApi reads er-api payload shape', () => {
  const v = parseFxApi({ result: 'success', base_code: 'USD', rates: { USD: 1, CNY: 6.685421 } });
  assert.equal(v, 6.685421);
});

test('parseFxApi rejects garbage', () => {
  assert.equal(parseFxApi(null), null);
  assert.equal(parseFxApi({ rates: {} }), null);
});

test('computeChange returns delta and pct vs previous', () => {
  const ticks = [
    { ts: 1, sell: 845.28 },
    { ts: 2, sell: 846.01 },
  ];
  const c = computeChange(ticks);
  assert.ok(Math.abs(c.delta - 0.73) < 1e-9);
  // pct is rounded to 4 decimals
  assert.ok(Math.abs(c.pct - (0.73 / 845.28 * 100)) < 1e-3);
});

test('computeChange with <2 ticks is zero', () => {
  assert.deepEqual(computeChange([{ ts: 1, sell: 1 }]), { delta: 0, pct: 0 });
  assert.deepEqual(computeChange([]), { delta: 0, pct: 0 });
});
