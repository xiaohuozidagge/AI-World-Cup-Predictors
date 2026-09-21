/**
 * v1.2 Premier League draw-model tuning + pre-registration.
 *
 * Honest data partition (§三):
 *   burn-in      2021-22  (warms state, never a label source)
 *   training     2022-23  (fits each candidate draw model)
 *   selection    2023-24  (selects feature set + L2, no re-fitting here)
 *   development  2024-25  (benchmark after refit — never used to re-select)
 *   locked       2025-26  (NOT touched here — run exactly once by the validate script)
 *
 * Flow (§六):
 *   1. Collect pre-match training rows (raw 23 features + draw label) for 2022-23,
 *      warmed by 2021-22, using the FROZEN v1 core state.
 *   2. For each feature set A/B/C and each L2 ∈ {0.01, 0.1, 1, 10}, standardize
 *      (training stats only) and fit an L2-regularized logistic regression → 12
 *      candidate configs.
 *   3. Select on 2023-24 by log loss → Brier → draw Brier → fewer params.
 *   4. Refit the winning (featureSet, L2) on 2022-23 + 2023-24 combined.
 *   5. Run the 2024-25 development benchmark (v1 / v1.1 / v1.2) — no re-selection.
 *   6. Freeze: write config.json + pre-registration.json + training-report.json +
 *      development-report.json. The acceptance criteria are written here, BEFORE
 *      2025-26 has ever been read.
 *
 * No runtime clock, no network, no randomness. 2025-26 is never loaded into any
 * computation here.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  actualOutcomeDistribution,
  buildDrawModelConfig,
  computeConfusionMatrix,
  computeConfidenceBreakdown,
  computeDrawMetrics,
  computeMatchContext,
  computeMetrics,
  computeNoPriorSeasonLookup,
  computeScorelineQuality,
  computeStandardization,
  dateToDayIndex,
  decayState,
  extractFeatureVector,
  featureSetSize,
  groupMatchesByDate,
  hashConfig,
  initFeatureState,
  initialModelState,
  predictedOutcomeDistribution,
  recordMatchToFeatureState,
  regressEloToMean,
  resolveConfig,
  runBacktest,
  scorelineDistribution,
  standardizeFeatures,
  trainLogisticRegression,
  updateEloAfterMatch,
  updateStrengthAfterMatch,
  validateDrawModelConfig,
  type DrawModelConfig,
  type DeepPartial,
  type FeatureSet,
  type ModelConfig,
  type ModelMatch,
} from "../lib/model"
import {
  ACCEPTANCE_CRITERIA_V12,
  BURN_IN_SEASON,
  DEVELOPMENT_SEASON_V12,
  filterSeasons,
  inputDataHash,
  loadModelMatches,
  MODEL_DIR,
  MODEL_DIR_V11,
  MODEL_DIR_V12,
  readJson,
  SELECTION_SEASON_V12,
  TRAINING_SEASON_V12,
  V12_FEATURE_SETS,
  V12_L2_VALUES,
  WARM_SEASONS_FOR_DEV_V12,
} from "./model-inputs"

const EPS = 1e-9
const MODEL_VERSION = "1.2.0"

function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

/** One training/selection row: the raw 23-feature vector plus a draw label. */
interface TrainingRow {
  matchId: string
  season: string
  raw: number[]
  label: number // 1 = draw, 0 = non-draw
}

/**
 * Walk matches chronologically (identical state-evolution loop to `runBacktest`)
 * and collect pre-match raw feature vectors + draw labels for the given seasons.
 * Prediction always precedes same-day update, so no match's own result reaches
 * its own features.
 */
function collectTrainingRows(matches: ModelMatch[], config: ModelConfig, collectSeasons: Set<string>): TrainingRow[] {
  const state = initialModelState()
  const featureState = initFeatureState()
  const promotedBySeason = computeNoPriorSeasonLookup(matches)
  const rows: TrainingRow[] = []

  for (const [date, group] of groupMatchesByDate(matches)) {
    const dayIndex = dateToDayIndex(date)
    const days = dayIndex - state.dayIndex
    if (days > 0) {
      const factor = Math.exp((-Math.LN2 * days) / config.strength.halfLifeDays)
      decayState(state.strength, state.league, factor)
    }
    state.dayIndex = dayIndex

    const season = group[0].season
    if (state.season !== null && state.season !== season) regressEloToMean(state.elo, config)
    state.season = season

    for (const m of group) {
      if (collectSeasons.has(m.season)) {
        const ctx = computeMatchContext(m, state, config)
        const raw = extractFeatureVector(
          {
            eloHome: ctx.eloHome,
            eloAway: ctx.eloAway,
            lambdaHome: ctx.lambdaHome,
            lambdaAway: ctx.lambdaAway,
            baseDrawProbability: ctx.baseMatrix.oneX2.draw,
            homeCoverage: ctx.homeStrength.matchesObserved,
            awayCoverage: ctx.awayStrength.matchesObserved,
            homeState: featureState.teams[m.homeSlug],
            awayState: featureState.teams[m.awaySlug],
            noPriorSeason: promotedBySeason[m.season] ?? new Set<string>(),
            homeSlug: m.homeSlug,
            awaySlug: m.awaySlug,
          },
          "C",
        )
        rows.push({ matchId: m.id, season: m.season, raw, label: m.homeGoals === m.awayGoals ? 1 : 0 })
      }
    }

    for (const m of group) {
      updateEloAfterMatch(state.elo, m.homeSlug, m.awaySlug, m.homeGoals, m.awayGoals, config)
      updateStrengthAfterMatch(state.strength, state.league, m.homeSlug, m.awaySlug, m.homeGoals, m.awayGoals)
      recordMatchToFeatureState(featureState, m)
    }
  }

  return rows
}

interface Candidate {
  index: number
  featureSet: FeatureSet
  l2: number
  drawModel: DrawModelConfig
  config: ModelConfig
  configHash: string
  logLoss: number
  brier: number
  drawBrier: number
  accuracy1X2: number
  predictedDrawCount: number
  drawRecall: number
  drawPrecision: number
}

/** Selection priority: log loss → Brier → draw Brier → fewer params → grid order. */
function better(a: Candidate, b: Candidate): boolean {
  if (!epsEq(a.logLoss, b.logLoss)) return a.logLoss < b.logLoss
  if (!epsEq(a.brier, b.brier)) return a.brier < b.brier
  if (!epsEq(a.drawBrier, b.drawBrier)) return a.drawBrier < b.drawBrier
  const aSize = featureSetSize(a.featureSet)
  const bSize = featureSetSize(b.featureSet)
  if (aSize !== bSize) return aSize < bSize
  if (a.l2 !== b.l2) return a.l2 < b.l2
  return a.index < b.index
}

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf-8")
}

function summarize(preds: ReturnType<typeof runBacktest>) {
  return { metrics: computeMetrics(preds), drawMetrics: computeDrawMetrics(preds) }
}

function main(): void {
  const allMatches = loadModelMatches()
  const v1Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))
  const v11Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V11, "config.json")))

  /* ---- 1. training rows (2022-23, warmed by 2021-22) ---- */
  const trainWalkMatches = filterSeasons(allMatches, [BURN_IN_SEASON, TRAINING_SEASON_V12])
  const trainRows = collectTrainingRows(trainWalkMatches, v1Config, new Set([TRAINING_SEASON_V12]))

  /* ---- 2. 12 candidate draw models, trained on 2022-23 ---- */
  const candidates: Candidate[] = []
  let index = 0
  for (const featureSet of V12_FEATURE_SETS) {
    const d = featureSetSize(featureSet)
    const raw = trainRows.map((r) => r.raw.slice(0, d))
    const labels = trainRows.map((r) => r.label)
    const std = computeStandardization(raw)
    const X = standardizeFeatures(raw, std)
    for (const l2 of V12_L2_VALUES) {
      const fit = trainLogisticRegression(X, labels, l2)
      const drawModel = buildDrawModelConfig(featureSet, l2, std.means, std.stdDevs, fit.coefficients, fit.intercept)
      validateDrawModelConfig(drawModel)
      const config: ModelConfig = { ...v1Config, version: MODEL_VERSION, drawModel }
      candidates.push({
        index,
        featureSet,
        l2,
        drawModel,
        config,
        configHash: hashConfig(config),
        logLoss: Number.NaN,
        brier: Number.NaN,
        drawBrier: Number.NaN,
        accuracy1X2: Number.NaN,
        predictedDrawCount: Number.NaN,
        drawRecall: Number.NaN,
        drawPrecision: Number.NaN,
      })
      index++
    }
  }

  /* ---- 3. selection on 2023-24 ---- */
  const selectionMatches = filterSeasons(allMatches, [BURN_IN_SEASON, TRAINING_SEASON_V12, SELECTION_SEASON_V12])
  for (const c of candidates) {
    const preds = runBacktest(selectionMatches, c.config, { evaluateSeasons: [SELECTION_SEASON_V12] })
    const metrics = computeMetrics(preds)
    const draw = computeDrawMetrics(preds)
    c.logLoss = metrics.logLoss
    c.brier = metrics.brierScore
    c.drawBrier = draw.drawBrier
    c.accuracy1X2 = metrics.accuracy1X2
    c.predictedDrawCount = draw.predictedDrawCount
    c.drawRecall = draw.drawRecall
    c.drawPrecision = draw.drawPrecision
  }
  const sorted = [...candidates].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0))
  const best = candidates.reduce((acc, r) => (better(r, acc) ? r : acc), candidates[0])

  /* ---- 4. refit the winning (featureSet, L2) on 2022-23 + 2023-24 ---- */
  const refitWalkMatches = filterSeasons(allMatches, [BURN_IN_SEASON, TRAINING_SEASON_V12, SELECTION_SEASON_V12])
  const refitRows = collectTrainingRows(refitWalkMatches, v1Config, new Set([TRAINING_SEASON_V12, SELECTION_SEASON_V12]))
  const dBest = featureSetSize(best.featureSet)
  const refitRaw = refitRows.map((r) => r.raw.slice(0, dBest))
  const refitLabels = refitRows.map((r) => r.label)
  const refitStd = computeStandardization(refitRaw)
  const refitX = standardizeFeatures(refitRaw, refitStd)
  const refitFit = trainLogisticRegression(refitX, refitLabels, best.l2)
  const refitDrawModel = buildDrawModelConfig(
    best.featureSet,
    best.l2,
    refitStd.means,
    refitStd.stdDevs,
    refitFit.coefficients,
    refitFit.intercept,
  )
  validateDrawModelConfig(refitDrawModel)
  const finalConfig: ModelConfig = { ...v1Config, version: MODEL_VERSION, drawModel: refitDrawModel }
  const finalConfigHash = hashConfig(finalConfig)

  /* ---- 5. development benchmark on 2024-25 (no re-selection) ---- */
  const devMatches = filterSeasons(allMatches, WARM_SEASONS_FOR_DEV_V12)
  const v12DevPreds = runBacktest(devMatches, finalConfig, { evaluateSeasons: [DEVELOPMENT_SEASON_V12] })
  const v1DevPreds = runBacktest(devMatches, v1Config, { evaluateSeasons: [DEVELOPMENT_SEASON_V12] })
  const v11DevPreds = runBacktest(devMatches, v11Config, { evaluateSeasons: [DEVELOPMENT_SEASON_V12] })

  const v12Dev = summarize(v12DevPreds)

  /* ---- 6. freeze: write artifacts ---- */
  writeJson(MODEL_DIR_V12, "config.json", finalConfig)

  const trainingReport = {
    schemaVersion: 1,
    evaluationType: "tuning",
    modelVersion: MODEL_VERSION,
    inputDataHash: inputDataHash(),
    seasons: { burnIn: BURN_IN_SEASON, training: TRAINING_SEASON_V12, selection: SELECTION_SEASON_V12 },
    grid: {
      featureSets: V12_FEATURE_SETS,
      l2Values: V12_L2_VALUES,
      size: candidates.length,
    },
    objective: {
      primary: "multiclassLogLoss",
      secondary: "brierScore",
      tertiary: "drawBrier",
      quaternary: "fewerParams",
      direction: "minimize (logLoss/Brier/drawBrier), prefer fewer features, then grid order",
    },
    selectionPriority: ["logLoss", "brierScore", "drawBrier", "fewerParams", "gridOrder"],
    trainRowCount: trainRows.length,
    results: sorted.map((c) => ({
      index: c.index,
      featureSet: c.featureSet,
      l2: c.l2,
      configHash: c.configHash,
      logLoss: c.logLoss,
      brier: c.brier,
      drawBrier: c.drawBrier,
      accuracy1X2: c.accuracy1X2,
      predictedDrawCount: c.predictedDrawCount,
      drawRecall: c.drawRecall,
      drawPrecision: c.drawPrecision,
    })),
    best: {
      index: best.index,
      featureSet: best.featureSet,
      l2: best.l2,
      configHash: best.configHash,
      logLoss: best.logLoss,
      brier: best.brier,
      drawBrier: best.drawBrier,
      accuracy1X2: best.accuracy1X2,
      predictedDrawCount: best.predictedDrawCount,
      drawRecall: best.drawRecall,
      drawPrecision: best.drawPrecision,
    },
    refit: {
      seasons: [TRAINING_SEASON_V12, SELECTION_SEASON_V12],
      featureSet: best.featureSet,
      l2: best.l2,
      refitRowCount: refitRows.length,
      configHash: finalConfigHash,
      drawModel: refitDrawModel,
    },
  }
  writeJson(MODEL_DIR_V12, "training-report.json", trainingReport)

  const developmentReport = {
    schemaVersion: 1,
    evaluationType: "development_benchmark",
    modelVersion: MODEL_VERSION,
    inputDataHash: inputDataHash(),
    configHash: finalConfigHash,
    seasons: { warm: WARM_SEASONS_FOR_DEV_V12, development: DEVELOPMENT_SEASON_V12 },
    note:
      "2024-25 is a DEVELOPMENT benchmark — the feature set and L2 were already " +
      "fixed on 2023-24 before this run, and no re-selection is performed here.",
    models: {
      v1_2: {
        ...v12Dev,
        confidenceBreakdown: computeConfidenceBreakdown(v12DevPreds),
        predictedOutcomeDistribution: predictedOutcomeDistribution(v12DevPreds),
        actualOutcomeDistribution: actualOutcomeDistribution(v12DevPreds),
        confusionMatrix: computeConfusionMatrix(v12DevPreds),
        scorelineDistribution: scorelineDistribution(v12DevPreds, 10),
        scorelineQuality: computeScorelineQuality(v12DevPreds, 10),
      },
      v1: summarize(v1DevPreds),
      v1_1: summarize(v11DevPreds),
    },
  }
  writeJson(MODEL_DIR_V12, "development-report.json", developmentReport)

  const preRegistration = {
    schemaVersion: 1,
    evaluationType: "pre_registration",
    modelVersion: MODEL_VERSION,
    configHash: finalConfigHash,
    inputDataHash: inputDataHash(),
    note:
      "Written BEFORE the 2025-26 locked validation has ever been run. The config " +
      "hash, acceptance criteria, and partition are frozen here; the validate " +
      "script must reproduce them verbatim and apply the criteria exactly once.",
    selectedFeatureSet: best.featureSet,
    selectedL2: best.l2,
    partition: {
      burnIn: BURN_IN_SEASON,
      training: TRAINING_SEASON_V12,
      selection: SELECTION_SEASON_V12,
      development: DEVELOPMENT_SEASON_V12,
      lockedValidation: "2025-26",
    },
    acceptanceCriteria: ACCEPTANCE_CRITERIA_V12,
  }
  writeJson(MODEL_DIR_V12, "pre-registration.json", preRegistration)

  console.log(`model:v12:tune — 12 candidates (3 feature sets × 4 L2) trained on ${TRAINING_SEASON_V12}, selected on ${SELECTION_SEASON_V12}`)
  console.log(`  best: featureSet=${best.featureSet} l2=${best.l2}`)
  console.log(`  selection logLoss=${best.logLoss.toFixed(4)} brier=${best.brier.toFixed(4)} drawBrier=${best.drawBrier.toFixed(4)} acc=${best.accuracy1X2.toFixed(4)}`)
  console.log(`  refit on ${TRAINING_SEASON_V12}+${SELECTION_SEASON_V12} (${refitRows.length} rows) → configHash ${finalConfigHash.slice(0, 12)}…`)
  const dev = v12Dev.metrics
  console.log(`  dev ${DEVELOPMENT_SEASON_V12}: v1.2 logLoss=${dev.logLoss.toFixed(4)} brier=${dev.brierScore.toFixed(4)} acc=${(dev.accuracy1X2 * 100).toFixed(2)}% | draws predicted ${v12Dev.drawMetrics.predictedDrawCount}`)
  console.log(`\nwrote config.json, pre-registration.json, training-report.json, development-report.json under ${MODEL_DIR_V12}`)
}

main()
