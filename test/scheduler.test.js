import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleSchedule } from '../lib/scheduler.js';

/** Controllable timer harness: manual advance, ordered firing. */
function fakeTimers() {
  let seq = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { fn, ms, at: ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    /** Fire the soonest job (advancing virtual time by its delay). */
    async fireNext() {
      let best = null;
      for (const [id, j] of jobs) if (!best || j.at < jobs.get(best).at) best = id;
      assert.ok(best, 'a timer must be pending');
      const j = jobs.get(best);
      jobs.delete(best);
      await j.fn();
      for (const other of jobs.values()) other.at -= j.at;
      return j.ms;
    },
    pending: () => jobs.size,
  };
}

test('healthy cycles reschedule at the normal interval', async () => {
  const t = fakeTimers();
  const delays = [];
  const sched = createCycleSchedule({
    run: async () => ({ healthy: true }),
    cycleMs: 30 * 60_000, firstDelayMs: 15_000, backoffBaseMs: 60_000,
    setTimeoutImpl: t.setTimeout, clearTimeoutImpl: t.clearTimeout,
  });
  delays.push(await t.fireNext()); // first run (15s)
  delays.push(await t.fireNext()); // healthy → normal interval
  delays.push(await t.fireNext());
  assert.deepEqual(delays, [15_000, 30 * 60_000, 30 * 60_000]);
  sched.stop();
});

test('failed cycles back off 1m/2m/4m… capped at the normal interval', async () => {
  const t = fakeTimers();
  const delays = [];
  const sched = createCycleSchedule({
    run: async () => ({ healthy: false }), // llmError / stale quote / throw
    cycleMs: 30 * 60_000, firstDelayMs: 15_000, backoffBaseMs: 60_000,
    setTimeoutImpl: t.setTimeout, clearTimeoutImpl: t.clearTimeout,
  });
  delays.push(await t.fireNext());
  delays.push(await t.fireNext());
  delays.push(await t.fireNext());
  delays.push(await t.fireNext());
  delays.push(await t.fireNext()); // 1m,2m,4m,8m
  delays.push(await t.fireNext()); // 16m
  delays.push(await t.fireNext()); // 32m → capped to 30m
  delays.push(await t.fireNext()); // still capped while failing
  assert.deepEqual(delays.slice(1), [60_000, 120_000, 240_000, 480_000, 960_000, 30 * 60_000, 30 * 60_000]);
  sched.stop();
});

test('recovery resets the backoff to the normal interval', async () => {
  const t = fakeTimers();
  let healthy = false;
  const sched = createCycleSchedule({
    run: async () => ({ healthy }),
    cycleMs: 30 * 60_000, firstDelayMs: 15_000, backoffBaseMs: 60_000,
    setTimeoutImpl: t.setTimeout, clearTimeoutImpl: t.clearTimeout,
  });
  await t.fireNext(); // fail → 1m pending
  healthy = true;
  const d1 = await t.fireNext(); // retry runs healthy
  const d2 = await t.fireNext();
  assert.equal(d1, 60_000, 'the pending retry still fires at its scheduled time');
  assert.equal(d2, 30 * 60_000, 'healthy again → normal interval');
  sched.stop();
});

test('a throwing run still reschedules (loop never dies)', async () => {
  const t = fakeTimers();
  let calls = 0;
  const sched = createCycleSchedule({
    run: async () => { calls += 1; throw new Error('boom'); },
    cycleMs: 30 * 60_000, firstDelayMs: 15_000, backoffBaseMs: 60_000,
    setTimeoutImpl: t.setTimeout, clearTimeoutImpl: t.clearTimeout,
  });
  await t.fireNext();
  await t.fireNext();
  assert.equal(calls, 2, 'both attempts ran');
  assert.equal(t.pending(), 1, 'a retry is always pending');
  sched.stop();
  assert.equal(t.pending(), 0, 'stop clears the pending timer');
});

test('paused products keep the normal cadence without running', async () => {
  const t = fakeTimers();
  let calls = 0;
  const paused = true;
  const sched = createCycleSchedule({
    run: async () => { calls += 1; return { healthy: true }; },
    isPaused: () => paused,
    cycleMs: 30 * 60_000, firstDelayMs: 15_000, backoffBaseMs: 60_000,
    setTimeoutImpl: t.setTimeout, clearTimeoutImpl: t.clearTimeout,
  });
  await t.fireNext();
  await t.fireNext();
  assert.equal(calls, 0, 'paused → run never invoked');
  assert.equal(t.pending(), 1, 'still scheduled');
  sched.stop();
});
