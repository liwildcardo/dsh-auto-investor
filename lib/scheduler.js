/**
 * Outcome-aware strategy-cycle scheduler (robustness R1):
 *  - first run after activation fires quickly (15s + small stagger);
 *  - a HEALTHY cycle (no llmError, fresh quote) reschedules at cycleMs;
 *  - a failing cycle (throw / llmError / stale quote) retries with
 *    exponential backoff (1m, 2m, 4m … capped at cycleMs) so the plugin
 *    starts working within ~a minute of the environment recovering instead
 *    of waiting out a full 30-minute slot;
 *  - the loop always reschedules — no failure path kills it.
 */

/** First-run delay: fast start, products staggered (capped) to avoid bursts. */
export const firstDelayMs = (index, staggerMs) => 15_000 + index * Math.min(staggerMs, 30_000);

/**
 * Cycle outcome → health verdict (the whole R1 backoff contract, unit-tested).
 * Deliberate holds (busy/paused) are NOT environment failures; a missing or
 * stale quote and an llmError ARE (the environment is not ready to work).
 */
export function assessCycle(res, nowMs = Date.now(), maxAgeMs = 300_000) {
  if (!res) return { healthy: false, reason: 'no-result' };
  if (res.llmError) return { healthy: false, reason: 'llm-error' };
  if (res.busy || res.paused) return { healthy: true, reason: 'skipped' };
  if (!Number.isFinite(res.quoteTs) || res.quoteTs <= 0) return { healthy: false, reason: 'no-quote' };
  if (nowMs - res.quoteTs > maxAgeMs) return { healthy: false, reason: 'stale-quote' };
  return { healthy: true, reason: 'ok' };
}

export function createCycleSchedule({
  run,
  isPaused = () => false,
  cycleMs,
  firstDelayMs = 15_000,
  backoffBaseMs = 60_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let timer = null;
  let failStreak = 0;
  let stopped = false;

  const delayFor = () => {
    if (failStreak === 0) return cycleMs;
    return Math.min(backoffBaseMs * (2 ** (failStreak - 1)), cycleMs);
  };

  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeoutImpl(tick, ms);
  };

  async function tick() {
    timer = null;
    if (stopped) return;
    // The whole body is guarded: even a throwing isPaused/setTimeoutImpl must
    // leave a pending retry behind — "no failure path kills the loop".
    try {
      let healthy = false;
      if (isPaused()) {
        failStreak = 0;
      } else {
        const result = await run();
        healthy = result?.healthy !== false;
        failStreak = healthy ? 0 : failStreak + 1;
      }
      schedule(healthy || failStreak === 0 ? cycleMs : delayFor());
    } catch {
      try {
        failStreak += 1;
        schedule(delayFor());
      } catch { /* the timer implementation itself is broken; nothing else to do */ }
    }
  }

  schedule(firstDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer != null) clearTimeoutImpl(timer);
      timer = null;
    },
  };
}
