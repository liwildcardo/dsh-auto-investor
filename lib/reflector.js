/**
 * @deprecated 单产品时代的版本学习辅助。多产品版本/复盘见 core/engine.js；此文件仅供旧测试与历史参考。
 */
/**
 * Reflection loop: per-strategy-version performance tracking, loss-triggered
 * revision, and stability evaluation for the user-facing reference strategy.
 */

/** New strategy version record. */
export function createVersion(id, strategy, createdAt = Date.now()) {
  return {
    id,
    strategy,
    createdAt,
    trades: 0, // round-trips (realized outcomes), not fills
    fills: 0, // executed fills (buys/conversions) — not scored
    wins: 0,
    consecLosses: 0,
    returnPnl: 0,
    startPnl: null, // total P&L mark when the version began (mark-to-market base)
    peakPnl: 0,
    maxDrawdownPnl: 0,
    reference: false,
    retired: false,
  };
}

/** Book one trade outcome (pnl delta in RMB) into a version. */
export function recordOutcome(version, pnlDelta) {
  version.trades += 1;
  version.returnPnl += pnlDelta;
  if (pnlDelta > 0) {
    version.wins += 1;
    version.consecLosses = 0;
  } else if (pnlDelta < 0) {
    version.consecLosses += 1;
  }
  if (version.returnPnl > version.peakPnl) version.peakPnl = version.returnPnl;
  const dd = version.returnPnl - version.peakPnl;
  if (dd < version.maxDrawdownPnl) version.maxDrawdownPnl = dd;
  return version;
}

/** Whether the version's performance demands a reflection/revision pass. */
export function shouldReflect(stats, cfg) {
  if (stats.returnPct <= cfg.reflectLossPct) return true;
  if (stats.consecLosses >= cfg.reflectConsecLosses) return true;
  if (stats.maxDrawdownPct <= cfg.reflectMaxDrawdownPct) return true;
  return false;
}

/** Whether the version qualifies as a stable, reference-worthy strategy. */
export function stabilityCheck(stats, cfg, benchmarkPct) {
  const base = stats.trades >= cfg.stableMinTrades
    && stats.returnPct > cfg.stableMinReturnPct
    && stats.maxDrawdownPct >= cfg.stableMaxDrawdownPct;
  if (!base) return false;
  if (benchmarkPct !== undefined && stats.returnPct <= benchmarkPct) return false; // must add alpha
  return true;
}

/** Convert a version record into comparable stats (percent of capital). */
export function versionStats(version, capitalRmb) {
  const base = capitalRmb > 0 ? capitalRmb : 1;
  return {
    trades: version.trades,
    wins: version.wins,
    winRate: version.trades > 0 ? version.wins / version.trades : 0,
    consecLosses: version.consecLosses,
    returnPnl: version.returnPnl,
    returnPct: (version.returnPnl / base) * 100,
    maxDrawdownPnl: version.maxDrawdownPnl,
    maxDrawdownPct: (version.maxDrawdownPnl / base) * 100,
  };
}
