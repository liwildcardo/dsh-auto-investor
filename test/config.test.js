import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';

test('resolveConfig applies defaults', () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.perTradeLimitRmb, 5000);
  assert.equal(cfg.totalLimitRmb, 100000);
  assert.equal(cfg.initialCapitalRmb, 100000);
  assert.equal(cfg.spreadCnyPerGram, 5.0);
  assert.equal(cfg.minTradeGrams, 1);
  assert.equal(cfg.minTradeRmb, 1200);
  assert.equal(cfg.toTermMinGrams, 10);
  assert.equal(cfg.pricePollSec, 60);
  assert.equal(cfg.newsPollMin, 15);
  assert.deepEqual(cfg.tradingWindow, { startMin: 9 * 60 + 10, endMin: 26 * 60 });
});

test('resolveConfig merges user overrides', () => {
  const cfg = resolveConfig({ perTradeLimitRmb: 3000, spreadCnyPerGram: 4, newsPollMin: 5 });
  assert.equal(cfg.perTradeLimitRmb, 3000);
  assert.equal(cfg.spreadCnyPerGram, 4);
  assert.equal(cfg.newsPollMin, 5);
  assert.equal(cfg.totalLimitRmb, 100000);
});
