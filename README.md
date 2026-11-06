# 自动投资机 · dsh-auto-investor

> DeepSeek Harness 插件：黄金模拟投资引擎 —— LLM 决策 + 策略复盘学习循环 + 实时仪表盘。
>
> **仅模拟盘，不连接任何真实券商/银行账户。** 所有交易都是本机记账的假想成交。

---

## 功能

- **行情采集**：黄金现货 XAU/USD + 美元兑人民币汇率，按 `mid = xauUsd × usdCny ÷ 31.1035` 换算为 元/克，60 秒轮询；买卖价按招行黄金账户口径加/减点差。
- **资讯采集**：6 个免费权威源（中国人民银行、中国黄金协会、Kitco、中新网、人民网、CNBC）+ 联网搜索增强；相关性打分过滤、URL 去重、真实发布日期解析（URL/文章页元数据），无法解析时标记为「约」估计时间。
- **LLM 策略决策**：每 30 分钟一轮，模型拿到行情摘要、持仓、相关性×时效排序的资讯、策略版本绩效与交易计划，输出 `buy / sell / hold / toTerm / fromTerm` + 理由 + 置信度 + 计划。
- **风控纪律**：止损/止盈、单笔 ≤5000 元、累计 ≤10 万元、交易频率上限（每日笔数 + 最小间隔）、置信度门槛、单日亏损熔断、总回撤熔断。
- **策略学习循环**：每个策略版本记录真实成交/平仓/收益/回撤；亏损、连亏、回撤或 24 小时定期触发**复盘**，LLM 结合「上一轮决策 + 当时所见资讯 + 实盘结果」给出改进版策略，必要时分叉新版本。
- **仪表盘**：持仓概览、K 线式价格走势、完整策略卡（含交易计划与复盘结论）、复盘日志、最近交易、最新资讯；操作区只提供 **立即分析 / 立即复盘 / 暂停·恢复**（用户不直接下单，下单是策略引擎的产出）。
- **Agent 工具**：`auto_investor_status`、`auto_investor_run`、`auto_investor_reflect`、`auto_investor_news`。

## 系统要求

- **DeepSeek Harness**（桌面端或 `dsh` CLI）
- **Node.js ≥ 22.13**（使用内置 `node:sqlite`；缺失时自动回退 JSON 存储）
- 一个已配置的 LLM 提供方（插件默认使用当前会话的默认模型；未配置时自动降级为规则基线策略，不会崩溃）

## 安装

### 方式一：让 Agent 安装（推荐）

把本仓库克隆到本地，然后在 DeepSeek Harness 的会话里对 Agent 说：

> 把 `D:\path\to\dsh-auto-investor` 作为一个 bundle 插件安装并启用

Agent 会调用插件管理器完成：`install_bundle`（目标为克隆目录的**绝对路径**）→ 启用 entry `include:auto-investor`。完成后**刷新页面**即可在对话视图看到「自动投资机」仪表盘。

### 方式二：手动安装

1. 克隆到任意目录（例如 `D:\plugins\dsh-auto-investor`）。
2. 编辑 profile 的 `package.json`（`%DSH_HOME%/profiles/<profile>/package.json`），加入依赖与 bundle：

   ```json
   {
     "dependencies": {
       "dsh-auto-investor": "link:D:/plugins/dsh-auto-investor"
     },
     "dsh": {
       "profile": {
         "bundles": [ "...existing...", "dsh-auto-investor" ]
       }
     }
   }
   ```

3. 在 profile 的 `node_modules` 下建立指向克隆目录的 junction/symlink：`node_modules/dsh-auto-investor → D:/plugins/dsh-auto-investor`。
4. 重启 DeepSeek Harness（或禁用/启用该插件），刷新页面。

> 插件补丁声明见 [`cordis.patch.yml`](./cordis.patch.yml)：`insert: [{ id: auto-investor, name: dsh-auto-investor }]`。

## 配置

插件配置通过 bundle patch 的 `config` 传入（默认值见 [`lib/config.js`](./lib/config.js)）。常用项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `%DSH_HOME%/auto-investor-data` | 数据库与状态目录 |
| `initialCapitalRmb` | `100000` | 模拟起始资金 |
| `perTradeLimitRmb` / `totalLimitRmb` | `5000` / `100000` | 单笔、累计投资上限 |
| `spreadCnyPerGram` | `5.0` | 买卖点差（元/克） |
| `pricePollSec` / `newsPollMin` / `cycleMin` | `60` / `15` / `30` | 行情、资讯、策略周期（秒/分钟） |
| `tradingWindow` | 9:10–次日02:00 | 交易时段（Asia/Shanghai） |
| `holidays` | `[]` | 额外非交易日 `YYYY-MM-DD` |
| `defaultPlan` | 波段/2笔/4h/60%仓/止损-3%/止盈+6% | 初始交易计划（策略会自我调整，受硬上限约束） |
| `llmProvider` / `llmModel` | 空 | 留空则使用当前默认模型 |

## 数据

- 数据库：`%DSH_HOME%/auto-investor-data/auto-investor.db`（SQLite；不可用时回退同名 `.json`）
- 内容：行情点位、资讯、交易记录、持仓、策略版本、决策与复盘日志
- 想**从头训练**：停用插件后删除该数据库文件即可（或只清空 `trades`/`portfolio`/`versions`）

## 工作方式

```
行情轮询(60s) ─┐
资讯采集(15m) ─┴→ 策略周期(30m) → LLM 决策 → 风控/频率闸门 → 模拟成交 → 绩效累计
                                     ↑                                    │
                                     └──────── 复盘（亏损/连亏/回撤/24h）←─┘
```

- 每个策略版本独立记账（成交、平仓、收益、回撤），亏损或定期复盘时由 LLM 检讨并给出改进版策略。
- 版本仅在**亏损触发**或**计划实质性变化**时分叉；定期复盘若计划无变化则只记录结论、不切版本。

## 开发

```bash
npm test        # 运行全部测试（Node 内置 test runner）
```

测试覆盖：行情换算、交易规则、频率纪律、风控、组合记账、新闻解析/相关性/排序、LLM 提示词、策略复盘、路由、客户端结构等。

## 免责声明

本项目仅用于**模拟与学习**，不构成任何投资建议；模拟收益不代表真实交易结果。请勿将其用于实盘自动交易。

## License

[MIT](./LICENSE)
