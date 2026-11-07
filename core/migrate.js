/**
 * 一次性迁移：把单产品（黄金）时代的 state 键复制到 product:gold:* 命名空间。
 * 原键保留一版，便于回滚。迁移幂等：已有 product:gold:account 时跳过。
 */
export function migrateGoldState(db) {
  if (db.getState('product:gold:account')) return { migrated: false };

  const portfolio = db.getState('portfolio');
  const versions = db.getState('versions');
  const reflections = db.getState('reflections');
  const decisions = db.getState('decisions');
  const paused = db.getState('paused');
  const lastReflectAt = db.getState('lastReflectAt');
  if (!portfolio && !versions && reflections == null) return { migrated: false };

  if (portfolio) {
    // 克重组合 → 多标的账户（AU9999 持仓）
    const grams = Number(portfolio.grams ?? 0);
    const account = {
      currency: 'CNY',
      cash: Number(portfolio.cash ?? 100000),
      initial: 100000,
      positions: grams > 0
        ? { AU9999: { qty: grams, costAvg: Number(portfolio.costAvg ?? 0), earliestSellTs: 0 } }
        : {},
      realizedPnl: Number(portfolio.realizedPnl ?? 0),
      invested: Number(portfolio.investedRmb ?? 0),
    };
    db.putState('product:gold:account', account);
  }

  if (Array.isArray(versions) && versions.length) {
    db.putState('product:gold:versions', versions.map(v => ({
      id: v.id,
      createdAt: v.createdAt ?? 0,
      strategy: {
        signals: v.strategy?.signals ?? [],
        risk: v.strategy?.risk ?? {},
        plan: v.strategy?.plan ?? {},
      },
      critique: v.strategy?.critique ?? null,
      startPnl: v.startPnl ?? 0,
      retired: v.retired === true,
    })));
    db.putState('product:gold:currentVersionId', versions[versions.length - 1]?.id ?? 1);
  }

  if (Array.isArray(reflections)) db.putState('product:gold:reflections', reflections);
  if (Array.isArray(decisions)) db.putState('product:gold:decisions', decisions);
  if (paused != null) db.putState('product:gold:paused', paused === true);
  if (lastReflectAt != null) db.putState('product:gold:lastReflectAt', lastReflectAt);
  return { migrated: true };
}
