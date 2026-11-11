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
    if (isPaused()) {
      failStreak = 0;
      schedule(cycleMs);
      return;
    }
    let healthy = false;
    try {
      const result = await run();
      healthy = result?.healthy !== false;
    } catch {
      healthy = false;
    }
    failStreak = healthy ? 0 : failStreak + 1;
    schedule(healthy ? cycleMs : delayFor());
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
