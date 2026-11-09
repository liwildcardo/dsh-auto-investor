/**
 * Bar-level long-only backtest for a signal configuration.
 * Simulation assumptions (documented for honesty):
 *  - signals are evaluated on the close of bar i and the entry fills at that
 *    same close (close-based, no intrabar fill model);
 *  - exits trigger when the unrealized return hits stop/take at a later close;
 *  - equity compounds per closed trade; open positions are marked at the end;
 *  - no fees/slippage (add them when comparing across brokers).
 */
import { evaluateSignals, compositeScore } from './signals.js';

const round2 = (v) => Math.round(v * 100) / 100;

export function runBacktest({ bars, signals = [], threshold = 0.8, stopLossPct = -5, takeProfitPct = 10 }) {
  const closes = (bars ?? []).filter(Number.isFinite);
  if (closes.length < 5) return { ok: false, reason: '数据不足', bars: closes.length };

  let inPos = false;
  let entry = 0;
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  let trades = 0;
  let wins = 0;
  const mark = (v) => {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, (v - peak) / peak);
  };

  for (let i = 0; i < closes.length; i += 1) {
    const price = closes[i];
    const window = closes.slice(0, i + 1);
    const score = compositeScore(evaluateSignals(signals, { series: window, volumes: [], news: [] }));
    if (inPos) {
      const ret = ((price - entry) / entry) * 100;
      if (ret <= stopLossPct || ret >= takeProfitPct) {
        equity *= 1 + ret / 100;
        trades += 1;
        if (ret > 0) wins += 1;
        inPos = false;
        mark(equity);
      } else {
        mark(equity * (1 + ret / 100));
      }
    }
    if (!inPos && score >= threshold) {
      inPos = true;
      entry = price;
    }
  }
  if (inPos) {
    const ret = ((closes[closes.length - 1] - entry) / entry) * 100;
    equity *= 1 + ret / 100;
    trades += 1;
    if (ret > 0) wins += 1;
    mark(equity);
  }

  const returnPct = (equity - 1) * 100;
  const buyHold = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  return {
    ok: true,
    bars: closes.length,
    trades,
    wins,
    winRate: trades ? Math.round((wins / trades) * 1000) / 1000 : null,
    returnPct: round2(returnPct),
    maxDrawdownPct: round2(maxDD * 100),
    buyHoldReturnPct: round2(buyHold),
    beatBuyHold: returnPct > buyHold,
    params: { threshold, stopLossPct, takeProfitPct },
  };
}
