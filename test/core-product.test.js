import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN, loadProducts } from '../core/registry.js';
import { validateProduct, normalizeProduct } from '../core/product.js';

test('all builtin products satisfy the contract', () => {
  assert.equal(BUILTIN.length, 4);
  for (const p of BUILTIN) {
    const check = validateProduct(p);
    assert.ok(check.ok, `${p.id}: ${check.errors.join('; ')}`);
  }
});

test('loadProducts returns normalized products in page order', () => {
  const list = loadProducts();
  assert.deepEqual(list.map(p => p.id), ['gold', 'ashare', 'us', 'hk']);
  for (const p of list) {
    assert.ok(p.rules.sessions.length > 0, `${p.id} has sessions`);
    assert.ok(p.universe.watchlist({}).length > 0, `${p.id} has a watchlist`);
    assert.ok(p.strategy.signals.length > 0, `${p.id} has signals`);
  }
});

test('loadProducts honours enabled list and overrides', () => {
  const only = loadProducts({ enabled: ['gold'] });
  assert.deepEqual(only.map(p => p.id), ['gold']);
  const overridden = loadProducts({ enabled: ['ashare'], overrides: { ashare: { name: 'A股（测试）' } } });
  assert.equal(overridden[0].name, 'A股（测试）');
});

test('validateProduct reports every structural problem', () => {
  const { ok, errors } = validateProduct({ id: 'Bad_ID' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.includes('missing name')));
  assert.ok(errors.some(e => e.includes('missing market')));
  assert.ok(errors.some(e => e.includes('kebab-case')));
});

test('normalizeProduct fills defaults without sharing arrays', () => {
  const raw = { ...BUILTIN[0], rules: { ...BUILTIN[0].rules } };
  const a = normalizeProduct(raw);
  const b = normalizeProduct(raw);
  a.rules.sessions.push([1, 2]);
  assert.notEqual(a.rules.sessions.length, b.rules.sessions.length);
  assert.equal(a.risk.perTrade, 5000);
});
