# 免费数据管道全量扩展 + 量化参数补齐 —— 设计文档

日期：2026-11-26
状态：待批准
范围决定：用户要求"全部做"——三档 14 条数据管道全量纳入，同时纳入首轮量化审视列出的策略参数与评估缺口（第二部分）。

## 1. 背景与意图（why）

以量化交易专家视角审视现有系统（黄金/A股/美股/港股四个产品的模拟投资引擎），结论：

1. **数据管道未用尽免费渠道**：现有 9 条管道中 3 条是"同源闲置"——腾讯报价 60+ 字段只取 5 个、gold-api 只取 XAU、东财 push2 接口族只用了一个 secid；另有一批零 key 官方免费源（CBOE/CFTC/Stooq/FRED 等）完全没接。
2. **因子覆盖单薄**：黄金只有 2 个宏观因子（实际收益率、美元指数的 5 日变化量），股票只有 PE 单因子；事件风险（FOMC/CPI/非农）、持仓情绪（COT/ETF 流）、市场宽度、板块轮动全部缺失。
3. **策略参数与评估缺口**：止损固定百分比不随波动率缩放（无 ATR）、无波动率目标仓位、trend/momentum 信号共线重复计数、回测零费用（黄金点差 ≈ 单边 0.6%）、无 Sharpe/Sortino 等风险调整指标、无样本外检验。

用户约束（A 档）：**只用免费、无需注册 key 的数据源**；随后用户要求三档管道全部做。

## 2. 目标 / 非目标 / 反目标

### 目标
- G1：14 条数据管道全部接入（清单见 §5），每条遵循现有"缓存 + staleness 门 + 失败沿用旧值 + 错误可观测"模式。
- G2：派生量化因子进入信号库（`core/signals.js` SIGNALS），按产品契约配置权重、可 evolvable；不可量化或易碎的信息进入 LLM prompt 宏观块。
- G3：回测补齐费用/滑点模型与风险调整指标（Sharpe、Sortino、profit factor、expectancy），并提供分段样本外对照。
- G4：策略参数补齐：ATR 自适应止损、波动率目标仓位、信号分组去共线、震荡 regime 候选门槛调节。
- G5：每条源落地前经"可用性探测"验证；探测失败的源标记 no-go 跳过，不阻塞其余管道。

### 非目标
- 不引入付费 API、不需要注册 key 的源（用户硬约束）。
- 不改 LLM 决策主流程（行情→信号→候选→LLM→风控闸门→成交的架构保持不变）。
- 不做空、不对冲、不引入期货/期权衍生交易。
- 不做北向资金（2024-08 起实时披露已停止，数据不再可得）。
- 不改交易时段、频率计划、招行/各市场规则校验逻辑。
- 不做 `client.js` 仪表盘改造：新指标/宏观块仅进 `status()` API 与 prompt（评审 Q9 决策）。
- 不接入 FRED：实测 no-go（直连挂起 + web 路由拒收 CSV，评审 Q4 决策），备份源改为财政部 XML。

### 反目标（做了就算失败）
- 任何新管道阻塞或拖慢决策周期（必须后台刷新、失败静默降级）。
- 任何因子在数据缺失时把综合分稀释为 0（必须走 noData 弃权模式）。
- 为接数据源引入新的运行时依赖包（保持零依赖，全部用内置 fetch/解析）。
- 新管道无测试、无 mock fetchFn 覆盖就合入。

## 3. 约束

- **免费无 key**：所有端点必须匿名可访问；被探测证实需要 key/登录的一律 no-go。
- **网络现实**：本设计沙箱无法直连 `push2.eastmoney.com`，但运行时 `lib/fallback-fetch.js` 已将 `push2.eastmoney.com` 与 `fred.stlouisfed.org` 列入 web.fetch 优先路由（`fallback-fetch.js:30`），且代码中 UI10Y 实际可用。每条源以**运行环境探测**为准，不以本沙箱为准。
- **既有模式必须复用**：
  - 缓存/staleness/26h 门/错误记录 → 照抄 `core/factor-sources.js` 的 `getEmFactor` 模式；
  - 因子后台刷新不阻塞周期 → 照抄 `engine.js` 的 `collectFactors` + 3s race 模式；
  - 信号 `noData` 弃权 → `compositeScore` 现有语义；
  - evolvable 白名单 + jump-guard + minSamplesToEvolve → 现有 reflection 防护（`engine.js:1213`、`core/product.js:60`）；
  - 测试 → node:test + mock fetchFn + fixture 快照（selector drift guard 模式，`test/news-pipeline.test.js:40`）。
- **产品契约**：所有产品差异（信号列表、权重、风险参数、fees）声明在 `products/*/index.js`；引擎不含产品常量。
- **数据状态存储**：沿用 `db.putState/getState` 自由键值（如 `factor:em:US10Y`），不引入表结构迁移。

## 4. 方案选型（approaches）

### 4.1 管道范围与落地方式
- **方案一：只做第 0+1 档（10 条）**——第 2 档脆弱源不做。工程量最小，但用户明确要求全量，否决。
- **方案二：14 条一次并行接入**——最快拿到全部因子，但脆弱源（FOMC 页面、SPDR 持仓、F10）失败模式各异，一次并入排查成本高，否决。
- **方案三（选定）：范围全量（用户决定），落地分批 + 每批先探测**——先建探测脚本框架，每批"探测 → 接入 → 测试"，no-go 的源记录后跳过。范围满足"全部做"，风险可控。

### 4.2 因子如何进入决策
- **方案一：全部做成加权信号**——事件日历、易碎页面类数据频繁 noData，会把信号列表变成噪音源，否决。
- **方案二：全部只进 prompt 给 LLM**——放弃了 reflection 可调、可回测的量化闭环，否决。
- **方案三（选定）：混合**——数值稳定、可回测的（收益率族、VIX、COT、宽度、估值深度等）进 SIGNALS 并可 evolvable；事件日历与易碎源（FOMC/CPI 日历、ETF 持仓）进 prompt 宏观块 + 轻量引擎闸门（事件窗口内提高开仓门槛），不参与打分。

### 4.3 Part 2 策略参数的取舍
- 止损体系：**ATR 止损与既有百分比止损并存，取更紧者，`hardStopLossPct` 仍是最终下限**（不推翻现有风控分层）。
- 信号共线：**给信号加可选 `group` 字段，组内先平均再参与加权**；缺省无组=现行为完全不变（存量配置零感知）。
- 评估扩展：**只增报告不改触发逻辑**——walk-forward 分段与敏感性分析作为 status 展示与人工观察输入，不自动拒绝版本（既有 jump-guard/minSamples 已防大跳）。

## 5. 第一部分：14 条数据管道清单

统一模式：`源 → 解析器(纯函数,可测) → db 缓存(带 fetchedAt/asOf/values) → 派生量(value/delta5d/percentile/zscore/stale) → 信号或 prompt`。
验证状态：✅=已实测；🔬=需运行环境探测（端点/字段待确认）。

| # | 档 | 管道 | 源与接口 | 频率 | 派生量 | 进入方式 | 降级策略 | 验证 |
|---|----|------|---------|------|--------|---------|---------|------|
| 1 | 0 | 腾讯报价字段扩展 | `qt.gtimg.cn` 现有请求，解析 f46=PB、f44/f45=流通/总市值、f47/f48=涨停/跌停价、f49=量比、f38=换手率、f43=振幅、f52=动态PE | 随现有 tick | PB 分位（与 PE 合成复合估值）、换手率分位、真实涨跌停价 | SIGNALS `valuation` 升级为 PE+PB 复合；`withinPriceBand` 优先用真实涨跌停价 | 字段缺失 → 该字段 null，估值信号回退纯 PE | ✅（sh600519 实测载荷）；⚠️ 美/港载荷字段索引需逐市场复验（PE f39 有先例） |
| 2 | 0 | 白银联动 | `api.gold-api.com/price/XAG`（与现用 XAU 同域） | 每 30min 缓存 | 金银比 = XAU/XAG；60 日累积分位 | SIGNAL `goldSilverRatio`（gold 产品） | 失败 → 累积历史沿用，delta 不足则 noData | ✅ HTTP 200 实测 |
| 3 | 0 | 名义收益率与利差 | 东财 `171.US10Y`、`171.US02Y`（与 UI10Y 同一 `getEmFactor`，仅 secid 不同） | 26h 门，同现有 | 通胀预期 = US10Y − UI10Y（同日配对）；2s10s 利差；各自 delta5d、60 日 z-score | SIGNAL `breakevenInflation`、`yieldCurve`（gold/us） | 沿用 getEmFactor 错误模式；两源日期不对齐 → 用 ≤ 当日最近配对 | 🔬（同接口族，push2 已在 web 路由名单） |
| 4 | 0 | 周/月K长历史 | `web.ifzq.gtimg.cn` 现有 fqkline，参数改 `week`/`month` | 播种一次 + 30min 重试门 | 5 年+ 周频收盘序列 | 仅供回测与长窗分位（**不混入信号 bar 桶**，避免污染日K 时间含义） | 失败 → 现有 120 日日K照常 | 🔬（同域名改参数） |
| 5 | 1 | A 股宽度与板块 | 东财 `clist` 全市场列表（fs 全 A + 行业板块，fields=f2,f3,f12,f14,f100） | 盘中 15min 缓存 | 涨跌家数比、涨跌停家数；个股所属行业当日涨幅（截面） | SIGNAL `breadth`、`sectorMomentum`（ashare）；prompt 展示板块表 | 请求失败 → 本轮两信号 noData | 🔬 |
| 6 | 1 | VIX | CBOE 官方 CSV `cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv` | 26h 门 | VIX 收盘、60 日分位、delta5d | SIGNAL `vixRegime`（gold/us/hk：高波动 → 避险/降仓倾向） | 失败沿用缓存；首拉失败 → noData | 🔬（官方 CDN，预期可得） |
| 7 | 1 | CFTC 持仓（COT） | CFTC 官方历史持仓 TXT/ZIP（dehistory 目录，黄金期货族） | 周频，26h×7 门 | 非商业净多头 / 总持仓比、60 周分位 | SIGNAL `cotPositioning`（gold） | 端点探测失败 → 该管道 no-go，记录后跳过 | 🔬（具体端点探测阶段确认） |
| 8 | 1 | Stooq 长历史 | `stooq.com/q/d/l/?s=<sym>&i=d`（零配额日线 CSV） | 播种一次 | 指数/个股 5 年+ 日线 | 回测样本增强（同管道 4 的用途） | 覆盖不到的标的 → 用腾讯日K | 🔬（符号命名 ^spx/aapl.us 探测确认） |
| 9 | 1 | 经济数据 CPI/PPI | 东财数据中心 datacenter-web 接口（reportName 系列） | 26h 门 | 同比读数、方向、距上次发布天数 | SIGNAL `inflationPrint`（gold）+ prompt 宏观块 | 探测失败 → no-go | 🔬 |
| 10 | 1 | 美债收益率备份源 | 美国财政部官网日收益率曲线 XML（`home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve`，免费无 key）；**FRED 实测 no-go**（评审 Q4：直连挂起 28–30s、web 路由拒收 application/csv） | 26h 门 | 名义各期限收益率、10Y−2Y；管道 3 的冗余备份 | 管道 3 的东财源失败时接管 breakeven/利差 + 回测宏观长历史 | 探测失败 → 管道 3 单源运行（无冗余，probe 输出中记录） | 🔬 |
| 11 | 2 | ETF 持仓（GLD/SPDR） | SPDR 官方日持仓 CSV/页面（端点探测确认） | 26h 门 | 持仓吨数、5 日变化 | prompt 宏观块（易碎源不打分） | 探测/解析失败 → 静默跳过 | 🔬（易碎，预期需选择器） |
| 12 | 2 | 融资融券 | 东财数据中心两融余额接口 | 26h 门 | 融资余额、5 日变化率 | SIGNAL `marginBalance`（ashare） | 探测失败 → no-go | 🔬 |
| 13 | 2 | 财报深度指标 | **优先**腾讯报价载荷尾部字段（同请求零成本，需逐字段验证 ROE/股息率/负债率/每股指标）；备选东财 F10 | 随 tick 或 26h | qualityScore = f(ROE, 负债率)、股息率分位 | SIGNAL `quality`、`dividendYield`（stocks） | 字段验证不过 → 只启用验证过的字段，全不过 → no-go | 🔬（载荷尾部确有数值字段，索引待验） |
| 14 | 2 | 事件日历（FOMC/非农/中国 CPI） | 美联储 FOMC 日程页、BLS 发布日历、国家统计局发布日程（均为官方免费页面） | 日历季度级缓存 | 未来事件日列表、最近事件距离（交易日） | prompt 日历块 + **引擎轻闸门**：事件前 1 交易日与当日，候选门槛 ×eventMultiplier（默认 1.2，产品可配）、事件后首日要求更高置信 | 页面改版解析失败 → 缓存沿用；无缓存 → 日历块显示"暂无"、闸门不生效 | 🔬（最易碎，放最后批次） |

## 6. 第二部分：策略参数与评估补齐

### 6.1 波动率参数化（`core/signals.js` + `core/engine.js`）
- **ATR 函数**：新增 `atr(values, period=14)`（需 high/low 序列；bar 只有收盘价时退化为基于收盘价的 TrueRange 近似——`barsFor` 现只存收盘价，探测阶段决定是否顺带给 DB 点位补 high/low，若补则需 schema 兼容）。
- **ATR 止损**：`risk.atrStopMult`（evolvable，**0–4，step 0.25，默认 0 = 关闭**——评审 Q8 决策：部署不得立刻收紧所有存量持仓的止损；与 `volTargetPct` 同为 opt-in，reflection 可在白名单内逐步激活，后续有回测证据后产品契约可设非零默认）。开启时止损价 = costAvg − atrStopMult × ATR；与既有 `stopLossPct` **取更紧者**；`hardStopLossPct` 仍是不可突破下限。`riskCheck()` 中按 symbol 计算，费用净额判定逻辑（现有 netPct）保持。
- **波动率目标仓位**：`risk.volTargetPct`（年化目标波动，默认 0 = 关闭 = 现行为）。开启时 `buyQuantity` 的 risk-budget 收紧为 `notional = capital × min(风险预算, volTarget / realizedVolAnnualized)`，仍受 perTrade/敞口上限截断。`minVolatility` 死市场门保留。

### 6.2 信号结构（`core/signals.js`）
- **分组去共线**：信号配置新增可选 `group`（如 `trend`/`momentum` 同属 `trendGroup`）。`compositeScore` 改为：同组先取组内均值，组间按（组内权重均值）加权。**无组信号行为与现状逐位一致**。四个产品的策略配置显式声明分组；**`normalizeVersions` 增加 group 回填**（产品契约有组、活动版本同 id 信号缺组 → 补写，与 risk 键填充同模式——评审 Q6 决策：分组是元数据同步，不改参数值，生效即为目标行为，随本批次上线立即去共线，而非等到下次 fork）。
- **震荡 regime 调节**：engine 在 `candidates()` 后计算 chop（快慢线距离 / ATR 归一，或 20 日高低点区间收窄度——builder 在两者中按测试结果选）；chop 时 `threshold × regimeMultiplier`（默认 1.2）。不新增管道，只用已有 bar 数据。

### 6.3 回测与评估（`core/backtest.js`）
- **回测数据序列（评审 Q1 决策）**：`runBacktestFor` 不再只用 `barsFor(sym)` 的 240 根短窗——优先取**长历史日线**（DB 种子：多产品现有 120 日种子扩到 640；黄金新增日线种子源，B1 探测选源，`seedHistory` 扩展到 single 产品），不足再回退现有 bar。回测统一在**日线**上运行，输出必带 `interval:'1d'` 与 `bars` 数。**split/OOS 与敏感性仅在 bars ≥ 250 时返回**，否则 `insufficient: true` 诚实降级——不在 240 根 1h 线上做假 walk-forward。信号参数在日线上的时间含义与 1h 实盘不同：回测评估的是**信号配置在日频的稳健性**，不宣称复现实盘 1h 行为（prompt/输出中注明）。
- **费用模型（评审 Q2 决策）**：单一机制 `costBps`（每边）——引擎按 `estimateCostBps(product)` 计算：`tradeFees(rules,'buy',perTrade).total / perTrade × 10000`（佣金/印花税/过户费按典型单笔规模归一；HK 最低佣金地板同样归一，近似记录在案）**＋**黄金点差 `spreadCnyPerGram ÷ 参考克价 × 10000`（参考价=回测首根收盘价换算克价）。`slippageBps` 为独立附加参数（默认 0）。回测每边扣 `costBps`——黄金 ≈0.6%/边 的真实点差由此进入回测，且不引入名义资金假设。
- **宏观因子参与回测（评审 Q3 决策）**：**纳入**。各因子采集器本就按日累积 `values[]`（≤400 obs）；回测按 bar 日期对齐喂 ctx（取 ≤ 日期的最近值），早于因子历史的 bar 保持 noData 弃权。split/敏感性因此评估的是**实盘真正跑的策略**（价格信号＋宏观信号），而非价格信号子集。
- **绩效指标**：新增 sharpe（日线 √252 年化）、sortino、profitFactor、expectancy、平均持仓 bar 数、总换手；与既有 winRate/returnPct/maxDD/buyHold 并列返回。
- **样本外**：`split: 0.7` → train/test 两段指标（同参数分别结算），test 段显著劣于 train 段时加 `warning` 字段；受 bars ≥ 250 门限约束。
- **参数敏感性**：新增 `analyzeSensitivity({bars, signals, grid})`：对指定 evolvable 路径 ±step 网格重跑，返回各参数值的指标平坦度（最差/最优比）。先作为 status 展示与 reflection 输入参考，**不自动改参数**。

### 6.4 事件闸门与展示（prompt）
- **事件闸门（评审 Q5 决策）**：**单一机制** = 候选门槛 × `eventMultiplier`（不另调 minConfidence，避免双路径）。窗口 = 事件日前 1 交易日至后 1 交易日（T−1、T、T+1），交易日按产品自身 `rules.holidays` + weekday 判定（gold `holidays:[]` → 仅排除周末）。事件→产品映射：FOMC/非农/美国 CPI → gold、us、hk（multiplier 默认 1.2）；中国 CPI → ashare（1.2）。`eventMultiplier` 产品契约可配，缺省 1.2、设 0 = 该产品闸门关闭；**四产品默认开启**，但日历数据不可用时闸门为 no-op（不报错不拦截）。挂点：`candidates()` 取 threshold 后按日历状态放大；prompt 同步提示门槛被调高及原因。
- `factorLines()` 扩展为分组宏观块（利率族 / 汇率与波动 / 持仓与资金 / 事件日历），每项带 stale 标记，沿用现有格式。
- 事件日历块给出未来 3 个事件（名称 + 日期 + 距今交易日数）。
- prompt 中新增一行说明事件窗口的开仓门槛调节，让 LLM 知道候选门槛被调高过。

## 7. 分期落地（供计划使用）

| 批次 | 内容 | 依赖 |
|------|------|------|
| B1 | **进程内探测框架**（评审 Q7 决策：`core/probe.js` + 管理路由 `/api/auto-investor/probe`，用**生产 fetchFn/路由**逐源断言"可达+可解析"，输出 go/no-go 表——独立 node 脚本拿不到 web 路由，仅作直连源的快捷方式）+ 管道 1/2/3/4（同源扩展）+ **黄金日线种子选源探测**（Q1：东财 `118.AU9999` kline / 腾讯期货 / Stooq xauusd 三选一） | 无 |
| B2 | 管道 5/6/8（宽度板块、VIX、Stooq）+ 对应 SIGNALS | B1 探测框架 |
| B3 | 管道 7/11/12/13（持仓与基本面）+ 对应 SIGNALS | B1；各源探测通过 |
| B4 | 管道 9/10/14（经济数据、FRED、日历）+ prompt 宏观块扩展 | B1；日历放最后 |
| B5 | Part 2 参数与回测（ATR、vol-targeting、分组、regime、回测费用/指标/样本外/敏感性） | 与 B1–B4 可并行 |

每批完成标准：探测通过（或记录 no-go）→ 接入 → 单测（mock fetch + fixture）→ 现有测试全绿。

## 8. 留给 builder 的

- 各 🔬 端点的实际探测结果适配（字段名、分页、日期格式、GBK 编码等细节）。
- 腾讯载荷字段索引在美/港市场的逐一复验与测试 fixture 制作。
- ATR 所需 high/low 数据是否入 DB 的 schema 兼容决策（§6.1 已给退化方案）。
- chop 指标的具体选型（§6.2 给了两个候选，按测试效果定）。
- 新信号在四个产品中的初始权重与 evolvable 范围标定（给出建议值并说明依据）。
- prompt 宏观块的最终文案与顺序（保持现有"数据 + stale 标记"风格）。
- 各批次的具体任务拆分与测试用例清单（writing-plans 阶段产出）。
- 新增信号的阈值标定（vixRegime/COT/宽度等的分位阈值，按历史数据或常识给初值并注明可 evolvable）。

## 9. 评审决策记录（builder-check 十问，设计者拍板）

| # | 问题 | 决策 | 影响 |
|---|------|------|------|
| Q1 | 回测跑什么 bar 序列？黄金没有日线 | 回测统一日线；黄金日线种子选源进 B1 探测（东财 AU9999/腾讯期货/Stooq 三选一）；种子扩到 640 根；split/敏感性 bars≥250 才返回，否则 `insufficient`；输出注明日频评估不等同 1h 实盘 | §6.3、§7 B1 |
| Q2 | `tradeFees` 对黄金返回 0，费用怎么进回测 | 单一 `costBps` 每边机制：固定费按 `perTrade` 典型规模归一（含 HK 地板）＋ 黄金点差按参考克价折算；`slippageBps` 附加默认 0 | §6.3 |
| Q3 | 宏观因子信号要不要参与回测 | 纳入：因子 `values[]` 按 bar 日期对齐喂 ctx，历史不足的 bar 走 noData 弃权 | §6.3 |
| Q4 | FRED 路由真的可用吗 | **不可用，实测 no-go**（直连挂起；web 路由拒收 application/csv；无 key 端点仅 CSV）。管道 10 改为**财政部日收益率曲线 XML** 作管道 3 备份；FRED 移入非目标 | §2、§5 管道 10 |
| Q5 | 事件闸门的机制/默认/交易日 | 单一机制=候选门槛 × eventMultiplier（不调 minConfidence）；窗口 T−1..T+1；交易日用产品自身 holidays；FOMC/非农/美 CPI→gold/us/hk、中国 CPI→ashare；默认 1.2、0=关、四产品默认开、无日历=no-op | §6.4 |
| Q6 | group 要不要回填存量版本 | 回填：`normalizeVersions` 同步 group（元数据，不改参数）；分组随本批上线立即生效（这正是去共线的目标），"零感知"限于无组信号 | §6.2 |
| Q7 | 探测脚本拿不到 web 路由怎么办 | 探测进进程：`core/probe.js` + `/api/auto-investor/probe` 路由，用生产 fetchFn；独立脚本仅作直连源快捷方式 | §7 B1 |
| Q8 | `atrStopMult` 默认开还是关 | **默认 0=关**（opt-in，与 volTargetPct 一致）；evolvable 0–4/step 0.25 允许 reflection 激活；部署不改变存量持仓止损行为 | §6.1 |
| Q9 | client.js 仪表盘要不要改 | 不改：新字段仅进 `status()` API 与 prompt；仪表盘列为非目标 | §2 |
| Q10 | vixRegime 对黄金的符号 | **按产品参数化方向**：gold 高 VIX → 正分（避险利好金）；us/hk 高 VIX → 负分（风险偏好打压）；信号带 `direction` 参数由产品契约设置 | §5 管道 6 |

评审同时确认可由 builder 自行判断的事项（不回问）：组内 noData 的均值语义、年化因子约定、各采集器落点（`core/` 新文件 + `factor-sources` 风格）、各产品管道开关、`slippageBps` 默认数值。
