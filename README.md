# 自动投资机 · dsh-auto-investor

> DeepSeek Harness 插件：多资产模拟投资平台 —— 黄金 / A股 / 美股 / 港股。
> 每个产品独立账户与引擎，规则引擎产出候选，LLM 做最终取舍，复盘持续训练策略。
>
> **仅模拟盘，不连接任何真实券商/银行账户。** 所有交易都是本机记账的假想成交。

---

## 产品

| 产品 | 币种 | 结算 | 手数 | 费用 | 交易时段（当地） |
|---|---|---|---|---|---|
| 黄金 | CNY | T+0 | 克 | 点差 5 元/克 | 09:10–次日 02:00 |
| A股 | CNY | T+1 | 100 股 | 佣金万2.5(最低5) + 卖出印花税0.05% + 过户费 | 09:30–11:30 / 13:00–15:00 |
| 美股 | USD | T+1 | 1 股 | 零佣金（可配） | 09:30–16:00（含夏令时） |
| 港股 | HKD | T+2 | 按手 | 佣金0.25%(最低100) + 双边印花税0.1% | 09:30–12:00 / 13:00–16:00 |

每个产品：独立资金（默认各 10 万本币）、独立自选池、独立资讯源、独立规则引擎与策略版本、独立页面。

## 功能

- **行情采集**：黄金（XAU/USD + 汇率）、A股/美股/港股（腾讯行情批量），按产品周期轮询；多标的按 `series` 表存序列。
- **资讯采集**：每产品注册自己的源清单（黄金 6 源；A股/美股/港股各自源），产品关键词相关性打分；池内每只标的按 6 小时缓存抓个股资讯；真实发布日期解析与陈旧剔除。
- **规则引擎**：指标（MA/ROC/RSI/波动率/量比）→ 信号（趋势/动量/RSI/突破/量能/估值/资讯情绪）→ 加权综合分 → 候选。
- **LLM 决策**：每产品独立周期（默认 30 分钟，按产品错峰），只在候选/持仓内选择，输出买卖数量/金额、理由、置信度。
- **风控**：止损止盈、交易时段、涨跌停、手数、费用、单笔/单标的/总敞口、频率上限、置信度门槛、单日亏损熔断。
- **学习循环**：版本 = 信号参数 + 风控参数；复盘 LLM 只能修改白名单参数且自动钳制上下界；亏损/定期/手动触发版本分叉。
- **仪表盘**：每个产品一个独立页面（页签切换），含持仓与收益（本币）、走势、策略版本、复盘记录、交易记录、标的资讯、操作区与当前模型。
- **Agent 工具**：`auto_investor_status/run/reflect/news`，均支持 `product` 参数（gold/ashare/us/hk）。

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
| `products` | `["gold","ashare","us","hk"]` | 启用的产品（决定页面与引擎） |
| `productConfig` | `{}` | 按产品覆盖配置，如 `{ "ashare": { "risk": { "perTrade": 8000 } } }` |
| `staggerSec` | `120` | 产品周期之间的错峰间隔（秒） |
| `dataDir` | `%DSH_HOME%/auto-investor-data` | 数据库与状态目录 |
| `initialCapitalRmb` | `100000` | 各产品起始资金（本币） |
| `perTradeLimitRmb` / `totalLimitRmb` | `5000` / `100000` | 单笔、累计上限（黄金；其他产品在各自 product 的 risk 中） |
| `spreadCnyPerGram` | `5.0` | 黄金买卖点差（元/克） |
| `pricePollSec` / `newsPollMin` / `cycleMin` | `60` / `15` / `30` | 行情、资讯、策略周期（秒/分钟） |
| `holidays` | `[]` | 额外非交易日 `YYYY-MM-DD`（各产品另有内置节假日表） |
| `llmProvider` / `llmModel` | 空 | 留空则使用当前默认模型 |

## 数据

- 数据库：`%DSH_HOME%/auto-investor-data/auto-investor.db`（SQLite；不可用时回退同名 `.json`）
- 表：`ticks`（黄金行情，带 product）、`series`（多标的价格序列：product+symbol+ts）、`trades`（带 product/symbol）、`news`（带 product）、`state`（键值，产品状态用 `product:<id>:` 前缀）
- 迁移：单产品时代的黄金状态会在首次启动时复制到 `product:gold:*` 命名空间（幂等）
- 想**从头训练**：停用插件后删除数据库；或只清空对应 `product:<id>:*` 的状态与该产品的交易记录

## 模型来源（重要）

插件调用 LLM 时使用 **Harness 的默认模型**（`agentDefaultModel.currentSelection()`），**不是**当前对话窗口里选择的模型：

| 操作 | 对投资机的影响 |
|---|---|
| 在对话窗口切换模型 | **不影响**——它继续使用默认模型 |
| 在 设置 → 默认模型 修改 | 下一次调用即生效（每次调用重新读取，无需重启） |
| 插件配置 `llmProvider` / `llmModel` | 优先级最高，覆盖默认模型 |
| 默认模型不可用（key 失效/模型下线） | 不会崩溃：分析轮次记录 `llmError` 并保持 hold，复盘返回 `LLM unavailable` |

仪表盘「操作」区会显示插件**当前实际使用**的 `provider/model`，便于核对。

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
