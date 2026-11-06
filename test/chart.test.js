import test from 'node:test';
import assert from 'node:assert/strict';
import { chartModel } from '../lib/market.js';

const ticks = Array.from({ length: 30 }, (_, i) => ({
  ts: Date.UTC(2026, 10, 2, 0, i * 5),
  mid: 870 + Math.sin(i / 3) * 5,
  sell: 867.5 + Math.sin(i / 3) * 5,
  buy: 872.5 + Math.sin(i / 3) * 5,
}));

test('chartModel produces polyline within plot bounds', () => {
  const m = chartModel(ticks, 640, 160, { padding: 24 });
  assert.ok(m.points.length > 0);
  for (const p of m.points) {
    assert.ok(p.x >= 0 && p.x <= 640, `x=${p.x}`);
    assert.ok(p.y >= 0 && p.y <= 160, `y=${p.y}`);
  }
});

test('chartModel generates Y axis ticks with price labels (元/克)', () => {
  const m = chartModel(ticks, 640, 160);
  assert.ok(m.yAxis.ticks.length >= 3, `y ticks=${m.yAxis.ticks.length}`);
  for (const t of m.yAxis.ticks) {
    assert.equal(typeof t.label, 'string');
    assert.ok(/\d/.test(t.label), `label=${t.label}`);
    assert.ok(t.y >= 0 && t.y <= 160);
  }
  // labels span min..max of the data
  const labels = m.yAxis.ticks.map(t => parseFloat(t.label));
  const max = Math.max(...ticks.map(t => t.mid));
  const min = Math.min(...ticks.map(t => t.mid));
  assert.ok(Math.max(...labels) >= max - 1);
  assert.ok(Math.min(...labels) <= min + 1);
});

test('chartModel generates X axis ticks with time labels', () => {
  const m = chartModel(ticks, 640, 160);
  assert.ok(m.xAxis.ticks.length >= 2, `x ticks=${m.xAxis.ticks.length}`);
  for (const t of m.xAxis.ticks) {
    assert.match(t.label, /\d{1,2}:\d{2}/, `label=${t.label}`);
    assert.ok(t.x >= 0 && t.x <= 640);
  }
  // monotonic left to right
  for (let i = 1; i < m.xAxis.ticks.length; i++) {
    assert.ok(m.xAxis.ticks[i].x > m.xAxis.ticks[i - 1].x);
  }
});

test('chartModel handles empty/single tick without crashing', () => {
  const m0 = chartModel([], 640, 160);
  assert.equal(m0.points.length, 0);
  const m1 = chartModel([ticks[0]], 640, 160);
  assert.ok(m1.yAxis.ticks.length >= 1);
});

test('chartModel reserves room for axis labels inside canvas', () => {
  const m = chartModel(ticks, 640, 160, { padding: 24 });
  // plot area must be inside canvas minus axis gutters
  assert.ok(m.plot.x0 > 0, 'left gutter for Y labels');
  assert.ok(m.plot.y1 < 160, 'bottom gutter for X labels');
  for (const p of m.points) {
    assert.ok(p.x >= m.plot.x0 && p.x <= m.plot.x1);
    assert.ok(p.y >= m.plot.y0 && p.y <= m.plot.y1);
  }
});
