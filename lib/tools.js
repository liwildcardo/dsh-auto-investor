/**
 * Agent tools: the same control operations the dashboard exposes (run/reflect/
 * news/status), with an optional `product` selector for the multi-product hub.
 * Deliberately no trade tool — the user controls analysis, never individual
 * orders; trades are the strategy engine's output.
 */

const PRODUCT_PARAM = {
  type: 'string',
  description: '产品 id：gold / ashare / us / hk（可选，缺省为第一个启用的产品）',
};

export function registerTools(ctx, service) {
  const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  const isHub = typeof service?.products === 'function';
  // A hub throws on unknown products; tools surface that as structured output
  // instead of letting the whole call fail.
  const safe = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };

  const defs = [
    {
      name: 'auto_investor_status',
      description: '自动投资机：查询模拟投资状态（产品、报价、持仓、收益、策略版本、最近交易）。',
      parameters: { type: 'object', properties: { product: PRODUCT_PARAM }, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute(args) {
        return safe(() => (isHub ? service.status(args?.product) : service.status()));
      },
    },
    {
      name: 'auto_investor_run',
      description: '自动投资机：立即运行一轮分析（采集行情/资讯 → LLM 决策 → 按规则模拟交易）。',
      parameters: { type: 'object', properties: { product: PRODUCT_PARAM }, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute(args) {
        return safe(() => (isHub ? service.runCycle(args?.product) : service.runCycle()));
      },
    },
    {
      name: 'auto_investor_reflect',
      description: '自动投资机：立即执行一次策略复盘（强制，绕过亏损/周期触发条件），返回复盘结论与版本变化。',
      parameters: { type: 'object', properties: { product: PRODUCT_PARAM }, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute(args) {
        return safe(() => (isHub ? service.reflectIfDue(args?.product, { force: true }) : service.reflectIfDue({ force: true })));
      },
    },
    {
      name: 'auto_investor_news',
      description: '自动投资机：查询已入库的资讯（黄金/股票按产品分开）。',
      parameters: {
        type: 'object',
        properties: {
          product: PRODUCT_PARAM,
          limit: { type: 'integer', description: '返回条数，默认 10' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute(args) {
        const limit = args?.limit ?? 10;
        if (isHub) return safe(() => ({ news: service.newsList(args?.product, limit) }));
        // newsList only — status() would recompute versionDisplay over all ticks.
        return { news: service.newsList(limit) };
      },
    },
    {
      name: 'auto_investor_backtest',
      description: '自动投资机：对某产品的当前信号配置做离线回测（信号按策略周期重采样，收盘价成交，含止损止盈），返回胜率/收益/回撤与买入持有对照。',
      parameters: {
        type: 'object',
        properties: {
          product: PRODUCT_PARAM,
          symbol: { type: 'string', description: '标的代码（可选，缺省为自选池第一只）' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute(args) {
        return safe(() => {
          if (!isHub) return { ok: false, error: 'backtest requires the multi-product hub' };
          return service.backtest(args?.product, args?.symbol);
        });
      },
    },
  ];

  const disposers = defs.map(d => ctx.tools.register(d));
  return () => { for (const d of disposers) d(); };
}
