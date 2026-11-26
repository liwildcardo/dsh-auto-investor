import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTencent } from '../core/quotes.js';

/**
 * 实盘 fixture：qt.gtimg.cn 一次抓取 sh600519 / hk00700 / usAAPL。
 * 扩展字段索引在 sh600519 实测（pb46/涨停47/跌停48/换手38/量比49）；
 * 美/港股载荷更短、字段位不对齐 → 必须降级为 null（见下例）。
 */
const TEXT = readFileSync(new URL('./fixtures/tencent-multi.txt', import.meta.url), 'utf8');

test('parseTencent 扩展字段（A股实盘 fixture）', () => {
  const quotes = parseTencent(TEXT);
  const sh = quotes.find((q) => q.symbol === 'sh600519');
  assert.ok(sh, 'sh600519 parsed');
  assert.ok(sh.pb > 6 && sh.pb < 7.5, `pb ≈ 6.74, got ${sh.pb}`);
  assert.ok(sh.limitUp > 1600 && sh.limitUp < 1650, `limitUp ≈ 1622, got ${sh.limitUp}`);
  assert.ok(sh.limitDown > 1300 && sh.limitDown < 1360, `limitDown ≈ 1327, got ${sh.limitDown}`);
  assert.ok(sh.turnover > 0.05 && sh.turnover < 0.5, `turnover > 0, got ${sh.turnover}`);
  assert.ok(sh.volRatio > 0.2 && sh.volRatio < 3, `volRatio > 0, got ${sh.volRatio}`);
  assert.ok(sh.pe > 0, '既有 PE 字段不受影响');
});

test('parseTencent 美/港股载荷字段位不对齐 → 扩展字段一律 null', () => {
  const quotes = parseTencent(TEXT);
  const hk = quotes.find((q) => q.symbol === 'hk00700');
  const us = quotes.find((q) => q.symbol === 'usAAPL');
  assert.ok(hk && us, 'hk/us 都解析出报价');
  for (const q of [hk, us]) {
    // hk46='TENCENT'、us47='Apple Inc.'、us48=360.83（有限值会伪装成
    // 跌停价 → 错误拒绝买单）：必须按市场门禁整体置 null。
    assert.equal(q.pb, null, `${q.symbol} pb null`);
    assert.equal(q.limitUp, null, `${q.symbol} limitUp null`);
    assert.equal(q.limitDown, null, `${q.symbol} limitDown null`);
    assert.equal(q.turnover, null, `${q.symbol} turnover null`);
    assert.equal(q.volRatio, null, `${q.symbol} volRatio null`);
    assert.ok(q.pe > 0, `${q.symbol} PE 仍可解析`);
    assert.ok(q.price > 0, `${q.symbol} price 正常`);
  }
});

test('parseTencent 损坏字段位 → 扩展字段 null 且不抛错', () => {
  const f = new Array(88).fill('--');
  f[0] = '1'; f[1] = '贵州茅台'; f[2] = '600519';
  f[3] = '10.00'; f[4] = '9.90'; f[5] = '9.95'; f[6] = '100'; f[39] = '22.26';
  const [q] = parseTencent(`v_sh600519="${f.join('~')}"`);
  assert.ok(q, 'quote parsed');
  assert.equal(q.pb, null);
  assert.equal(q.limitUp, null);
  assert.equal(q.limitDown, null);
  assert.equal(q.turnover, null);
  assert.equal(q.volRatio, null);
  assert.equal(q.pe, 22.26, '有效 PE 保留');
  // 空串字段位（Number('')===0）同样按无效处理
  const g = new Array(88).fill('');
  g[0] = '1'; g[2] = '600519'; g[3] = '10.00'; g[39] = '22.26';
  const [q2] = parseTencent(`v_sh600519="${g.join('~')}"`);
  assert.equal(q2.pb, null, '空串 → null（0 不算有效 PB）');
  assert.equal(q2.limitUp, null);
});

test('sz/科创板载荷同样解析扩展字段（fixture 钉住 sz 分支与 sh688 布局）', () => {
  const text = readFileSync(new URL('./fixtures/tencent-cn-extra.txt', import.meta.url), 'utf8');
  const quotes = parseTencent(text);
  const sz = quotes.find((q) => q.symbol === 'sz300750');   // 创业板
  const star = quotes.find((q) => q.symbol === 'sh688981'); // 科创板
  assert.ok(sz && star, 'sz300750 与 sh688981 都解析出报价');
  for (const q of [sz, star]) {
    assert.ok(q.pb > 0, `${q.symbol} pb > 0（got ${q.pb}）`);
    assert.ok(q.limitUp >= q.price, `${q.symbol} 涨停价 ≥ 现价`);
    assert.ok(q.limitDown <= q.price, `${q.symbol} 跌停价 ≤ 现价`);
    assert.ok(q.limitUp > q.limitDown, `${q.symbol} 涨停 > 跌停`);
    assert.ok(q.turnover > 0, `${q.symbol} 换手率 > 0`);
    assert.ok(q.volRatio > 0, `${q.symbol} 量比 > 0`);
    assert.ok(q.pe > 0, `${q.symbol} PE 正常`);
  }
});
