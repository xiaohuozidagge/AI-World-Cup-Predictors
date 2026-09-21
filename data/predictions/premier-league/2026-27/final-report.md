# 2026/27 英超候选预测（v1）— 最终报告

- 模型版本：`1.0.0`（v1，唯一允许模型）
- 冻结配置哈希：`28b50575b3ceea4dcad6d6d3e581f2895d825c84b82745def1214f9678679680`（全量校验，未变）
- 输入数据哈希：`48e760d814101f5e3fa045c99d62fc9f03b298c501a4f7546aee38885d44d923`（未变）
- 生成器哈希：`d2e29c5686706b9cc2da02efc3eeabce579d3a65c23082dcd5160533f6b17690`（修复后更新）
- 基准 commit：`c8763626e9743a65b2bf29eb2b702d63967650d8`
- 生成时间 `generatedAt`：`2026-09-21T15:21:05Z`（新真实时间）
- 数据截止 `dataCutoff`：`2026-09-18T00:20:33Z`（= 源快照 `sourceLastUpdatedAt`，未变）
- 结论：**READY FOR PHASE VIII — 380 场预测全部满足验收要求，正式预测数仍为 0**

---

## 一、目标

仅使用 **v1 模型**，基于已确认的项目内数据快照，生成 2026/27 英超候选预测
静态数据产物。**不修改任何页面**，**不生成正式预测**，**不进入预测锁定机制**。

- 40 场已完赛（FINISHED）→ 时间顺序回溯，`predictionType: "backtest"`、
  `predictionState: "historical_reconstruction"`、`eligibleForOfficialAccuracy: false`。
- 340 场未开赛 → 从单一冻结状态预测，`predictionType: "candidate"`、
  `predictionState: "unlocked"`、`eligibleForOfficialAccuracy: false`。
- `officialPredictionCount: 0`、`officialAccuracy: null`。

**达成情况：全部达成。**

## 二、数据

- 历史：football-data.co.uk E0 五个赛季 `2021-22`…`2025-26`（每季 380 场）。
- 现快照：`data/football/{competitions,teams,fixtures,manifest}.json`
  （football-data.org，`sourceLastUpdatedAt = 2026-09-18T00:20:33+00:00`）。
- 英超 2026 赛季：20 队、380 场（40 FINISHED + 340 未开赛，其中 2 支升班马
  `hull-city-afc`、`coventry-city-fc` 无历史，Elo 初始 1500 + `none` 层）。

## 三、模型与配置

v1 核心参数逐字节冻结：Elo（`initialRating=1500, kFactor=40, homeAdvantage=50,
seasonRegression=0, goalDiffFactor=0.2`）、strength（`halfLifeDays=180,
priorStrength=10`）、coverage（`limitedMaxMatches=38, mediumMaxMatches=114`）、
λ（`leagueHomeGoals=1.5, leagueAwayGoals=1.2, eloToLambda=0.001, maxEloDiff=200,
maxGoals=10`）、confidence、reasons（`maxReasons=5`）。

生成器断言并校验：

- `config.version === "1.0.0"` ✓
- `config.calibration === undefined` ✓（未使用 v1.1）
- `config.drawModel === undefined` ✓（未使用 v1.2）
- `hashConfig(resolveConfig(v1/config.json))` **全量**等于 `28b50575b3ce…` ✓

未重训、未改 v1 配置、未强制平局、未修改概率、未修改 `generateReasons`。

## 四、数据完整性检查

- 总场次 = 380（40 finished + 340 未开赛）✓
- 每场稳定唯一 `id` 与唯一 `slug`，无重复 ✓
- 主/客球队均可解析到 `teams.json`，20 支球队与静态俱乐部数据一致 ✓
- 完赛状态由**结果字段**（`fulltime_home_score`/`fulltime_away_score` 非空）判定，
  与 `status === "FINISHED"` 逐场一致，而非依赖当前时间 ✓
- 40 场完赛均有完整比分；340 场未开赛均无最终比分 ✓

## 五、Backtest（40 场回溯）

`replayMatches(历史 1900 场 + 40 场完赛, v1, evaluateSeasons=["2026-27"])`：
严格按日期分批、**先预测后更新**（同日比赛全部先预测、再吸收赛果），
预测无法读取自身赛果。

回溯指标（40 场，本阶段修复前后**完全不变**）：

| 指标 | 值 |
| ---- | ---- |
| 1X2 准确率 | 45.0%（18/40） |
| 精确比分 | 7.5%（3/40） |
| Brier | 0.6347 |
| Log loss | 1.0510 |
| 预测结果分布 H/D/A | 29 / 0 / 11 |
| 实际胜/平/负 | 13 / 14 / 13 |

## 六、Candidate（340 场候选预测）

冻结状态 = `replayMatches(...).finalState`（历史 + 40 场完赛结果吸收后）。
340 场候选全部从**同一冻结状态**预测（`predictMatch` 只读状态、不改变状态），
顺序无关，且不使用任何未来比赛的预测来更新状态。

## 七、时间参数与确定性

- 生成脚本**强制**要求 `--season` / `--generated-at` / `--data-cutoff`，
  核心逻辑无 `Date.now()` / `new Date()`。
- `dataCutoff` 必须等于源快照 `sourceLastUpdatedAt`（防猜测），且 ≤ `generatedAt`。
- 相同输入 + 相同时间参数连续运行两次，三份产物**字节级一致**
  （manifest `174818a1…`、predictions `12490a6a…`、report `90839017…`）。

## 八、理由（Reasons）与 DATA_COVERAGE 修复

### 修复前

v1 原始理由分布：2→24、3→54、4→148、5→154。其中 24 场（双方 Elo 差距 <50、
任一侧攻防强度均 ≤1.05、且双方历史充分）仅有「期望进球 + 主场优势」2 条，
未达到预注册的 3～5 条硬性要求。

### 修复方式（仅 artifact 层，未改 v1）

- 保留 v1 返回的全部原始理由；当原始理由 <3 条时，追加一条 `DATA_COVERAGE`。
- `DATA_COVERAGE` 完全来自赛前状态：`value = { home: 主队 matchesObserved,
  away: 客队 matchesObserved }`、`direction: "neutral"`、
  `source: "prediction-artifact"`、`comparisonValue = 38`（一整个赛季，
  对齐 v1 `coverage.limitedMaxMatches`）。
- 文案由真实 coverage 分三类生成：双方充分 / 一方样本不足 / 双方样本不足；
  明确**不表达主/平/客倾向**。
- 未修改 v1 的 `generateReasons`、未编造比赛信号、未改变任何预测数值。

### 修复后

- 理由分布：**3→78、4→148、5→154**（不再有 2 条）；380/380 场均满足 3～5。
- 追加 `DATA_COVERAGE` 的场次：**24 场**（全部为「双方历史充分」类）。
- 理由 code 无重复、排序确定、字节级可复现。

## 九、产物（`data/predictions/premier-league/2026-27/`）

- `manifest.json` — 元数据（configHash、inputDataHash、generatorHash、baseCommit、
  总数、官方预测数 0、官方准确率 null、20 队、源快照）。
- `predictions.json` — 380 条按 `kickoffUtc` 升序的预测（40 backtest + 340 candidate）。
- `backtest-report.json` — 40 场回溯指标（修复前后不变）、平局诊断、混淆矩阵、
  结果分布、比分分布、置信度分档。

## 十、脚本

| 脚本 | 作用 |
| ---- | ---- |
| `npm run predictions:pl:generate -- --season 2026-27 --generated-at <ISO> --data-cutoff <ISO>` | 生成三份产物 |
| `npm run predictions:pl:verify` | 只读验证 + 重推导字节级比对 |

新增/修改文件：`lib/model/prediction-artifact.ts`（纯函数，含 DATA_COVERAGE）、
`lib/model/prediction-artifact.test.ts`（105 测试）、
`scripts/prediction-inputs.ts`、`scripts/generate-premier-league-predictions-2026-27.ts`、
`scripts/verify-premier-league-predictions-2026-27.ts`；`package.json` 增加
`predictions:pl:generate` / `predictions:pl:verify` 并扩展 `test:model`。

## 十一、测试（105 项，全部通过）

`prediction-artifact.test.ts`：v1 配置全量哈希、calibration/drawModel 均为
undefined、版本 1.0.0、`replayMatches` 与 `runBacktest` 等价、拒绝 drawModel、
同日先预测后更新、回溯不读自身赛果、冻结状态顺序无关、`predictMatch` 不改状态、
backtest/candidate 状态与 actualScore 正确、`eligibleForOfficialAccuracy` 恒 false、
理由映射、排序、manifest 官方数为 0/准确率 null、回溯报告、哈希敏感；**新增
DATA_COVERAGE 专项 7 项**：中立可追溯、三类文案、2 条时追加 / 3 条时不追加、
无重复 code、coverage 不改变核心字段、value 等于赛前 matchesObserved。

`test:model` 由 73 增至 **105 全通过**。

## 十二、验证序列

1. `test:model`（105）、`test:history`（26）、`test:match`（30）— 全通过。
2. `predictions:pl:generate`（新 generatedAt，连续运行两次）— 字节级一致。
3. `predictions:pl:verify` — 全部通过（含重推导字节级比对、理由 3～5、
   无重复 code、DATA_COVERAGE 中立且来自赛前状态）。
4. `tsc --noEmit` — 0 类型错误。
5. `eslint`（5 个 Phase VII 文件）— 0 错误 0 警告。
6. `npm run build` — 退出码 0，PL 页面静态化无回归
   （`/premier-league` ○、`/premier-league/matches` ○、`[slug]` ● 380 路径）。
7. `git diff --check` — 空；`git status` 仅含预期新文件与 `package.json` 修改。

## 十三、已知限制（诚实披露）

- v1 预测平局 0 场（380 场预测结果分布 H=267 / D=0 / A=113），与 v1、v1.1、
  v1.2 在 2025-26 锁定验证中的行为一致（v1 从未将平局作为 argmax）。
- 2 支升班马无历史，Elo 从 1500 起步、强度收缩至联赛均值，置信度封顶为 low。
- `DATA_COVERAGE` 为 artifact 层追加的中性说明，不参与模型计算；仅当 v1
  原始理由不足 3 条时出现（24 场，均为双方历史充分类）。

## 十四、提交与停止规则

本阶段：**不修改** `c876362`；不 amend、不 rebase；不 push、不 deploy；
不修改页面；不进入预测锁定机制；不把 Candidate 标记为 locked；
不把 Backtest 标记为正式预测。全部验证通过后创建单一
`feat(model)` 提交（仅含 Phase VII 代码、测试、脚本、package.json 修改与
预测产物，不含任何页面修改）。完成后停止，不自动进入 Phase VIII。

## 十五、最终报告与结论

40 场 Backtest 与 340 场 Candidate 已按 v1 模型生成，产物三份齐备、可复现
（字节级一致）、无泄漏、无 v1.1/v1.2、无正式预测；全部 380 场理由均满足
3～5 条（DATA_COVERAGE 补齐 24 场 2 条缺口），预测核心字段、概率、比分、
置信度与回溯指标逐项不变。全部 105 项测试与完整验证序列通过。

**结论：READY FOR PHASE VIII — 380 场预测全部满足验收要求，正式预测数仍为 0。**
