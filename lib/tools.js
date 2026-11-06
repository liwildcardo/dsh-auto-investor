/**
 * Agent tools: the same control operations the dashboard exposes (run/reflect/
 * news/status). Deliberately no trade tool — the user controls analysis, never
 * individual orders; trades are the strategy engine's output.
 */

export function registerTools(ctx, service) {
  const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

  const defs = [
    {
      name: 'auto_investor_status',
      description: '自动投资机：查询当前模拟投资状态（报价、持仓、收益、策略版本、最近交易）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute() {
        return service.status();
      },
    },
    {
      name: 'auto_investor_run',
      description: '自动投资机：立即运行一轮分析（采集行情/资讯 → LLM 决策 → 按规则模拟交易）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute() {
        return service.runCycle();
      },
    },
    {
      name: 'auto_investor_reflect',
      description: '自动投资机：立即执行一次策略复盘（强制，绕过亏损/周期触发条件），返回复盘结论与版本变化。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute() {
        return service.reflectIfDue({ force: true });
      },
    },
    {
      name: 'auto_investor_news',
      description: '自动投资机：查询已入库的黄金相关资讯。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数，默认 10' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
      async execute(args) {
        // newsList only — status() would recompute versionDisplay over all ticks.
        return { news: service.newsList(args?.limit ?? 10) };
      },
    },
  ];

  const disposers = defs.map(d => ctx.tools.register(d));
  return () => { for (const d of disposers) d(); };
}
