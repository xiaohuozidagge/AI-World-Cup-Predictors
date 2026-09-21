# Premier League Prediction Model v1.2 — 最终报告

- 模型版本：`1.2.0`
- 冻结配置哈希：`951db54f02b8db401ebfbd2f731e50d5fe43037f3a165cb442a968dc69bb53c4`
- 输入数据哈希：`e2213a1eae51ac56d86163baa99764faee098b7cf9084dd5f9700934e9e41c34`
- 基准 v1 哈希：`28b50575b3ceea4dcad6d6d3e581f2895d825c84b82745def1214f9678679680`
- 对比 v1.1 哈希：`faa04987ac7ea10a0c13ee0b84730047c460e3a650e20604df61e454d3635475`
- 锁定验证赛季：`2025-26`（380 场）
- 结论：**REJECTED**

---

## 一、目标

在保留 v1 得分矩阵、1X2 概率、确定性、无数据泄漏，且不显著恶化
log loss / Brier / accuracy 的前提下，用一个轻量的确定性 L2 正则化逻辑回归，
逐场预测平局概率 `qDraw`（仅用赛前历史信息），使**一部分比赛真正以「平局」
作为 1X2 结果的 argmax**。

**达成情况：未达成。** v1.2 在 2025-26 锁定验证中预测平局 **0 场**，与 v1、
v1.1 相同，未能产生任何「平局为 argmax」的比赛。

## 二、设计

L2 正则化逻辑回归（Newton/Fisher 迭代，零初始化，截距不参与正则化，完全确定性）：

```text
qDraw = sigmoid(β₀ + Σ βᵢ · zᵢ)      # zᵢ 为标准化后的赛前特征
diagonalScale      = qDraw / baseDraw
nonDiagonalScale   = (1 − qDraw) / (1 − baseDraw)
```

对角单元 × `diagonalScale`，非对角单元 × `nonDiagonalScale`，再数值归一化。
该集成保对角线内部比例、非对角线内部比例、主客场相对关系；使 `draw = 对角线之和`，
`H + D + A = 1`；最终矩阵仍用于读取 top scoreline / top-3 与
`predictedOutcome == argmax`。唯一容差 `epsilon = 1e-12`。

## 三、数据划分

五个完整赛季，各 380 场，严格按时间顺序划分，无随机：

| 用途 | 赛季 | 说明 |
| ---- | ---- | ---- |
| Burn-in | 2021-22 | 预热 Elo / strength / 特征状态 |
| 训练 | 2022-23 | 拟合 12 个候选逻辑回归 |
| 选择 | 2023-24 | 选定特征集 + L2 |
| 开发基准 | 2024-25 | 已暴露基准（不重新选择） |
| 锁定验证 | 2025-26 | 冻结后仅运行一次 |

2025-26 严格不进入训练、选择、开发。运行前已写 `pre-registration.json`
（冻结配置哈希、验收阈值、划分），validate 脚本逐字复现并**仅运行一次**，
看到结果后不再调参。

## 四、冻结核心参数

v1 核心参数逐字节冻结：Elo（`kFactor=40, homeAdvantage=50, seasonRegression=0,
goalDiffFactor=0.2`）、strength（`halfLifeDays=180, priorStrength=10`）、
coverage、λ（`eloToLambda=0.001, maxEloDiff=200, maxGoals=10`）、confidence、
reasons。v1.2 从 v1 原始矩阵出发（`rho=0, drawMassMultiplier=1, goalScale=1`，
**无 `calibration` 字段**）。v1.1 参数不视为生产配置。

verify 脚本用 `assertCoreFrozen` 断言 v1.2 配置中上述各块与 v1 完全一致。

## 五、允许特征（23 个，全为赛前信息）

- **基础（6）**：绝对 Elo 差、总期望进球 `λ_home+λ_away`、绝对 λ 差、
  v1 基础平局概率、主/客数据覆盖数。
- **近 5 场（+9）**：主/客/联赛平均平局率、平均总进球、平均绝对净胜球
  （历史不足 5 场时用可用场次）。
- **赛季至今（+8）**：主/客进球/失球、进球差、失球差、样本不足标志、
  升班马/无历史标志。

约束全部满足：不含本场结果、不含赛后状态、同日先预测后更新、不用赔率/xG/
伤病/阵容/未来信息、无历史时用显式联赛中性默认值（绝不用未来均值）、
标准化统计仅来自训练集、无 `Math.random`/`Date.now`。

## 六、特征集与选择

3 个特征集（A=6 / B=15 / C=23）× 4 个 L2（`0.01, 0.1, 1, 10`）= 12 个候选。
选择优先级：log loss → Brier → draw Brier → 更少参数。

**选中：特征集 A，L2 = 1**（选择季 log loss 0.95547），在 2022-23 + 2023-24
（760 场）上重拟合。最终：

- 截距 `intercept = -1.2524896321691812`
- 系数 `[-0.00717, -0.01336, -0.01243, 0.01594, -0.00601, 0.00389]`

## 七、矩阵集成

见「二、设计」。`diagonalSum(out) == qDraw`、归一化和比例保持均由
`draw-model.test.ts` 直接断言。

## 八、验收标准（运行前固定，14 项）

| # | 检查项 | 阈值 | v1.2 于 2025-26 | 结果 |
| - | ------ | ---- | --------------- | ---- |
| 1 | 概率有效（和为 1） | 容差 1e-6 | 全部有效 | ✓ PASS |
| 2 | 预测平局数 ≥ 5% | ≥ 19 | **0** | ✗ FAIL |
| 3 | 无虚假平局膨胀 | ≤ 133 (35%) | 0 | ✓ PASS |
| 4 | 平局召回率 | ≥ 0.10 | **0.0000** | ✗ FAIL |
| 5 | 平局精确率 | ≥ 0.20 | **NaN** | ✗ FAIL |
| 6 | 平局 F1 | ≥ 0.13 | **NaN** | ✗ FAIL |
| 7 | 平局概率差（实际平局 vs 非平局） | > 0.01 | **0.0004** | ✗ FAIL |
| 8 | 平局 Brier vs v1 | ≤ +0.005 | +0.0002 | ✓ PASS |
| 9 | log loss vs v1 | ≤ +0.01 | −0.0001 | ✓ PASS |
| 10 | Brier vs v1 | ≤ +0.01 | −0.0001 | ✓ PASS |
| 11 | 1X2 准确率 vs v1 | ≥ −2pp | 0.00pp | ✓ PASS |
| 12 | 无单类别塌缩 | ≥ 2 类 | H=255, D=0, A=125 | ✓ PASS |
| 13 | 置信度未虚高 | 容差 0.03 | 单调（0.4618/0.6212） | ✓ PASS |
| 14 | 高置信度样本披露 | ≥ 10 | 0 样本（已披露） | ✓ PASS |

**结果：5 项失败（#2、#4、#5、#6、#7），9 项通过。**

## 九、指标

### 2024-25 开发基准（380 场）

| 模型 | 1X2 准确率 | 精确比分 | Brier | Log loss | 预测平局 |
| ---- | --------: | ------: | ----: | -------: | -------: |
| v1.2 | 51.32% | 11.32% | 0.59556 | 0.99772 | 0 |
| v1   | 51.32% | 11.32% | 0.59591 | 0.99807 | 0 |
| v1.1 | 51.32% | 11.84% | 0.59614 | 0.99823 | 0 |

### 2025-26 锁定验证（380 场，仅运行一次）

| 模型 | 1X2 准确率 | 精确比分 | Brier | Log loss | 预测平局 | 实际平局 |
| ---- | --------: | ------: | ----: | -------: | -------: | -------: |
| v1.2 | 48.95% | 9.47% | 0.62143 | 1.03376 | **0** | 104 |
| v1   | 48.95% | 9.47% | 0.62157 | 1.03384 | 0 | 104 |
| v1.1 | 48.95% | 11.05% | 0.62175 | 1.03387 | 0 | 104 |

v1.2 在所有「不恶化 v1」门禁上全部通过，且平局概率标定略优于 v1
（v1.2 平均平局概率 0.2225，实际平局 0.2228 / 非平局 0.2224；v1 为 0.2254，
实际平局 0.2272 / 非平局 0.2246）。但「产生平局」门禁全部失败。

## 十、文件

### 新增/修改（允许范围内）

- `lib/model/types.ts` — `FeatureSet`、`DrawModelConfig`。
- `lib/model/config.ts` — `drawModel?` 字段 + `resolveConfig` 附着（保留 v1/v1.1 哈希）。
- `lib/model/features.ts` — 特征计算与标准化。
- `lib/model/draw-model.ts` — 逻辑回归训练、预测、矩阵集成、配置校验。
- `lib/model/poisson.ts` — `readScoreMatrix`。
- `lib/model/predictor.ts` — `MatchContext`、`computeMatchContext`、`predictMatch` 施加平局目标。
- `lib/model/backtest.ts` — 维持特征状态。
- `lib/model/features.test.ts`、`lib/model/draw-model.test.ts`、`lib/model/backtest.test.ts`。
- `scripts/model-inputs.ts` — v1.2 常量与验收标准。
- `scripts/tune-premier-league-model-v12.ts`、`scripts/validate-premier-league-model-v12.ts`、`scripts/verify-premier-league-model-v12.ts`。
- `package.json` — 3 个脚本 + test:model 扩展。
- `docs/premier-league-prediction-model.md` — v1.2 章节。

### 数据产物（`data/model/premier-league/v1.2/`）

`config.json`、`pre-registration.json`、`training-report.json`、
`development-report.json`、`validation-report.json`、`calibration.json`、
`final-report.md`。

## 十一、脚本

| 脚本 | 作用 |
| ---- | ---- |
| `npm run model:v12:tune` | 训练 12 候选、选择、重拟合、开发基准 |
| `npm run model:v12:validate` | 2025-26 锁定验证（仅一次，与 tune 分离） |
| `npm run model:v12:verify` | 只读验证（一致性/可复现/无泄漏/确定性） |

## 十二、测试（20+ 项，全部通过）

- `features.test.ts`：7 项（尺寸/名称、状态记录、赛前排除自身结果、中性默认、
  标准化无泄漏、无历史查找、样本不足标志）。
- `draw-model.test.ts`：13 项（sigmoid、确定性、L2 收缩、对角和、归一化、
  比例保持、配置校验、predictMatch 施加平局、v1/v1.1 哈希不变、哈希稳定）。
- `backtest.test.ts`：含 v1.2 划分常数把 2025-26 严格排除在训练/选择之外。

`npm run test:model` → **73 通过 / 0 失败**。

## 十三、验证序列

1. `test:model`（73）、`test:history`（26）、`test:match`（30）、
   `test:static-queries`（16）、`test:static-clubs`（20）、`test:club-stats`（6）— 全部通过。
2. `verify:static-football` — PASSED。
3. `model:v12:tune` — 生成 config / pre-registration / training / development。
4. `model:v12:verify`（验证前）— 通过。
5. `model:v12:validate` — 运行一次，`status: rejected`。
6. `model:v12:verify`（验证后）— 通过（含 2025-26 复现、calibration 30 桶 × 380×3）。
7. `tsc --noEmit` — 无类型错误；`eslint`（改动文件）— 0 错误。
8. `npm run build` — 退出码 0，PL 页面静态化无回归。

verify 证明：v1/v1.1 未变且可复现；v1.2 配置合法、核心冻结、无 calibration；
配置哈希跨全部产物一致；划分诚实（2025-26 不在训练/选择/开发）；验收标准固定；
冻结配置确定（2024-25 / 2025-26 复现）；无泄漏、无 2026-27 引用。

## 十四、停止规则

结论为 **REJECTED**，因此：

- **不**生成 2026-27 预测；
- **不**部署、**不** commit / push / deploy；
- 保留 **v1** 作为基线；
- 如实记录失败（本报告及 `validation-report.json` 的 `status: rejected`）。

## 十五、最终报告与结论

v1.2 的失败是 §六「log loss 优先」与 §八「≥ 19 场预测平局」之间诚实的张力：
平局（约 25% 基础率）难以被允许的赛前特征线性可分，log loss 最优解收缩到截距
（`β₀ ≈ −1.25`），得到近似常数的 `qDraw ≈ 0.22`，从未超过约 0.35，因此 argmax
永不落在「平局」。能预测平局的低 L2 候选（选择季最多 18 场）以 log loss 与
Brier 恶化为代价，故不被 log loss 优先规则选中。v1.2 在平局标定上略优于 v1，
但 argmax 平局数仍为 0 —— 与 v1、v1.1 完全相同。

实现、测试、数据产物与最终报告均已按指令完成。无 2026-27 预测、无页面改动、
无部署、无 commit/push。

**结论：REJECTED — 继续保留 v1，不生成正式预测。**
