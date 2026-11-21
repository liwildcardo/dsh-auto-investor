import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonSafe } from '../lib/json.js';

const assertLossless = (v) => assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), v);

test('jsonSafe normalizes null-prototype rows to plain objects', () => {
  const row = Object.assign(Object.create(null), { a: 1 });
  const out = jsonSafe({ rows: [row] });
  assertLossless(out);
  assert.equal(out.rows[0].a, 1);
});

test('jsonSafe converts -0 to 0 and non-finite numbers to null', () => {
  const out = jsonSafe({ x: -0, y: NaN, z: Infinity, w: -0.001 });
  assertLossless(out);
  assert.ok(Object.is(out.x, 0));
  assert.equal(out.y, null);
  assert.equal(out.z, null);
  assert.equal(out.w, -0.001);
});

test('jsonSafe drops undefined properties and nullifies undefined leaves', () => {
  const out = jsonSafe({ a: undefined, b: [undefined, 1], c: 2 });
  assertLossless(out);
  assert.ok(!('a' in out));
  assert.deepEqual(out.b, [null, 1]);
});

test('jsonSafe converts Dates to ISO strings and functions to null', () => {
  const out = jsonSafe({ d: new Date('2026-11-06T00:00:00Z'), f: () => 1 });
  assertLossless(out);
  assert.equal(out.d, '2026-11-06T00:00:00.000Z');
  assert.equal(out.f, null);
});

test('jsonSafe keeps plain data unchanged', () => {
  const input = { s: 'x', n: 1.5, b: false, nul: null, arr: [1, 'a'], nested: { k: [true] } };
  assert.deepEqual(jsonSafe(input), input);
});
