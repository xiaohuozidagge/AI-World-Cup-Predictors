/**
 * v1.1 calibration search + locked-config validation.
 *
 * The v1 core parameters (Elo, strength, coverage, λ bounds, matrix cap) are
 * FROZEN — read from `data/model/premier-league/v1/config.json`. Only three
 * calibration knobs are searched over a bounded grid:
 *
 *   rho               ∈ {-0.20, -0.15, -0.10, -0.05, 0}
 *   drawMassMultiplier∈ {1.00, 1.05, 1.10, 1.15, 1.20, 1.25}
 *   goalScale         ∈ {0.90, 0.95, 1.00, 1.05}
 *
 * Selection is on 2022-23 + 2023-24 only (burn-in 2021-22). 2024-25 is the
 * accept/reject validation set, and 2025-26 is NEVER read here (it is an
 * exposed, post-hoc comparison only, run by the compare script).
 *
 * Writes config.json, tuning-report.json, and validation-report.json under
 * `data/model/premier-league/v1.1/`. No runtime clock, no network, no randomness.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  actualOutcomeDistribution,
  calibrationBuckets,
  computeConfusionMatrix,
  computeConfidenceBreakdown,
  computeDrawMetrics,
  computeMetrics,
  computeScorelineQuality,
  hashConfig,
  predictedOutcomeDistribution,
  resolveConfig,
  runBacktest,
  scorelineDistribution,
  validateCalibration,
  type CalibrationParams,
  type DeepPartial,
  type ModelConfig,
} from "../lib/model"
import {
  BURN_IN_SEASON,
  filterSeasons,
  inputDataHash,
  loadModelMatches,
  MODEL_DIR,
  MODEL_DIR_V11,
  readJson,
  TUNING_SEASONS_V11,
  VALIDATION_SEASON_V11,
} from "./model-inputs"

const EPS = 1e-9
const MODEL_VERSION = "1.1.0"

const RHO_VALUES = [-0.2, -0.15, -0.1, -0.05, 0]
const DRAW_MASS_VALUES = [1.0, 1.05, 1.1, 1.15, 1.2, 1.25]
const GOAL_SCALE_VALUES = [0.9, 0.95, 1.0, 1.05]

/**
 * Acceptance criteria — fixed BEFORE the validation set is run, and written
 * verbatim into the report so the pass/fail decision cannot be moved after the
 * fact. Not derived from any validation result.
 */
const ACCEPTANCE_CRITERIA = {
  minPredictedDraws: 1,
  minDrawRecall: 0, // strict > 0
  logLossTolerance: 0.01, // v1.1 must not worsen v1's same-period log loss by more
  brierTolerance: 0.01, // v1.1 must not worsen v1's same-period Brier by more
  maxPredictedDrawFraction: 0.5, // not majority-draw degenerate
  probSumTolerance: 1e-6,
  confidenceTolerance: 0.03, // rough monotonicity allowance
  minHighConfidenceSamples: 10, // skip high-level monotonicity check below this
}

function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

function buildV11Config(core: ModelConfig, cal: CalibrationParams): ModelConfig {
  return { ...core, version: MODEL_VERSION, calibration: { ...cal } }
}

interface Candidate {
  index: number
  rho: number
  drawMassMultiplier: number
  goalScale: number
  config: ModelConfig
  configHash: string
  logLoss: number
  brierScore: number
  drawBrier: number
  drawRecall: number
  drawPrecision: number
  accuracy1X2: number
  exactScoreAccuracy: number
  totalGoalsMAE: number
  predictedDrawCount: number
  invalidReason: string | null
}

/** Primary objective is log loss; tie-break Brier → draw Brier → accuracy → simpler. */
function better(a: Candidate, b: Candidate): boolean {
  const aInvalid = a.invalidReason !== null
  const bInvalid = b.invalidReason !== null
  if (aInvalid !== bInvalid) return !aInvalid
  if (aInvalid && bInvalid) return a.index < b.index
  if (!epsEq(a.logLoss, b.logLoss)) return a.logLoss < b.logLoss
  if (!epsEq(a.brierScore, b.brierScore)) return a.brierScore < b.brierScore
  if (!epsEq(a.drawBrier, b.drawBrier)) return a.drawBrier < b.drawBrier
  if (!epsEq(a.accuracy1X2, b.accuracy1X2)) return a.accuracy1X2 > b.accuracy1X2
  const aSimp = Math.abs(a.rho) + Math.abs(a.drawMassMultiplier - 1) + Math.abs(a.goalScale - 1)
  const bSimp = Math.abs(b.rho) + Math.abs(b.drawMassMultiplier - 1) + Math.abs(b.goalScale - 1)
  if (!epsEq(aSimp, bSimp)) return aSimp < bSimp
  return a.index < b.index
}

function allProbabilitiesValid(preds: ReturnType<typeof runBacktest>): boolean {
  for (const p of preds) {
    const { home, draw, away } = p.probabilities
    if (!(home >= 0 && draw >= 0 && away >= 0)) return false
    if (Math.abs(home + draw + away - 1) > ACCEPTANCE_CRITERIA.probSumTolerance) return false
  }
  return true
}

interface Check {
  name: string
  pass: boolean
  detail: string
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail }
}

function runValidation(
  matches: ReturnType<typeof loadModelMatches>,
  v1Config: ModelConfig,
  best: Candidate,
): { status: string; checks: Check[]; v1Metrics: ReturnType<typeof computeMetrics>; v11Metrics: ReturnType<typeof computeMetrics> } {
  const validationMatches = filterSeasons(matches, [
    BURN_IN_SEASON,
    ...TUNING_SEASONS_V11,
    VALIDATION_SEASON_V11,
  ])

  const v1Preds = runBacktest(validationMatches, v1Config, { evaluateSeasons: [VALIDATION_SEASON_V11] })
  const v1Metrics = computeMetrics(v1Preds)
  const v1Draw = computeDrawMetrics(v1Preds)

  const v11Preds = runBacktest(validationMatches, best.config, { evaluateSeasons: [VALIDATION_SEASON_V11] })
  const v11Metrics = computeMetrics(v11Preds)
  const v11Draw = computeDrawMetrics(v11Preds)
  const v11Confidence = computeConfidenceBreakdown(v11Preds)
  const v11Scoreline = computeScorelineQuality(v11Preds, 10)
  const predDist = predictedOutcomeDistribution(v11Preds)

  const distinctOutcomes = (["H", "D", "A"] as const).filter((o) => predDist[o].count > 0)

  const cb = v11Confidence
  const mediumMonotonic =
    cb.medium.count === 0 || cb.low.count === 0 || cb.medium.accuracy >= cb.low.accuracy - ACCEPTANCE_CRITERIA.confidenceTolerance
  const highMonotonic =
    cb.high.count < ACCEPTANCE_CRITERIA.minHighConfidenceSamples ||
    cb.medium.count === 0 ||
    cb.high.accuracy >= cb.medium.accuracy - ACCEPTANCE_CRITERIA.confidenceTolerance

  const checks: Check[] = [
    check(
      "predicted_draw_count_gt_0",
      v11Draw.predictedDrawCount >= ACCEPTANCE_CRITERIA.minPredictedDraws,
      `predicted ${v11Draw.predictedDrawCount} draws`,
    ),
    check("draw_recall_gt_0", v11Draw.drawRecall > ACCEPTANCE_CRITERIA.minDrawRecall, `draw recall ${v11Draw.drawRecall.toFixed(4)}`),
    check("probabilities_valid", allProbabilitiesValid(v11Preds), "all probabilities in [0,1] and sum to 1"),
    check(
      "log_loss_within_tolerance",
      v11Metrics.logLoss <= v1Metrics.logLoss + ACCEPTANCE_CRITERIA.logLossTolerance,
      `v1.1 ${v11Metrics.logLoss.toFixed(4)} vs v1 ${v1Metrics.logLoss.toFixed(4)} (Δ ${(v11Metrics.logLoss - v1Metrics.logLoss).toFixed(4)})`,
    ),
    check(
      "brier_within_tolerance",
      v11Metrics.brierScore <= v1Metrics.brierScore + ACCEPTANCE_CRITERIA.brierTolerance,
      `v1.1 ${v11Metrics.brierScore.toFixed(4)} vs v1 ${v1Metrics.brierScore.toFixed(4)} (Δ ${(v11Metrics.brierScore - v1Metrics.brierScore).toFixed(4)})`,
    ),
    check(
      "not_majority_draw",
      v11Draw.predictedDrawCount < ACCEPTANCE_CRITERIA.maxPredictedDrawFraction * v11Metrics.matchCount,
      `predicted draw fraction ${(v11Draw.predictedDrawCount / v11Metrics.matchCount).toFixed(4)}`,
    ),
    check(
      "no_single_category_collapse",
      distinctOutcomes.length >= 2,
      `predicted distribution H=${predDist.H.count} D=${predDist.D.count} A=${predDist.A.count}`,
    ),
    check(
      "confidence_roughly_monotonic",
      mediumMonotonic && highMonotonic,
      `low ${cb.low.accuracy.toFixed(4)} / medium ${cb.medium.accuracy.toFixed(4)} / high ${cb.high.accuracy.toFixed(4)}`,
    ),
  ]

  const status = checks.every((c) => c.pass) ? "accepted_for_exposed_comparison" : "rejected"

  const report = {
    schemaVersion: 1,
    evaluationType: "validation",
    modelVersion: MODEL_VERSION,
    inputDataHash: inputDataHash(),
    seasons: { burnIn: BURN_IN_SEASON, tuning: TUNING_SEASONS_V11, validation: VALIDATION_SEASON_V11 },
    configHash: best.configHash,
    status,
    acceptanceCriteria: ACCEPTANCE_CRITERIA,
    checks,
    v1: { metrics: v1Metrics, drawMetrics: v1Draw },
    v1_1: {
      metrics: v11Metrics,
      drawMetrics: v11Draw,
      confidenceBreakdown: v11Confidence,
      predictedOutcomeDistribution: predDist,
      actualOutcomeDistribution: actualOutcomeDistribution(v11Preds),
      confusionMatrix: computeConfusionMatrix(v11Preds),
      scorelineDistribution: scorelineDistribution(v11Preds, 10),
      scorelineQuality: v11Scoreline,
    },
  }

  mkdirSync(MODEL_DIR_V11, { recursive: true })
  writeFileSync(join(MODEL_DIR_V11, "validation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8")

  // §十三: probability-calibration reliability table, written alongside the
  // validation report. Buckets are per-outcome 10% bins (3 × 10 = 30), empty
  // buckets kept, no merging or dropping of poorly-calibrated buckets.
  const calibration = {
    schemaVersion: 1,
    evaluationType: "validation",
    modelVersion: MODEL_VERSION,
    configHash: best.configHash,
    bins: 10,
    outcomes: ["H", "D", "A"] as const,
    bucketCount: 30,
    buckets: calibrationBuckets(v11Preds, 10),
    drawCalibration: {
      actualDrawCount: v11Draw.actualDrawCount,
      avgPredictedDrawProbability: v11Draw.avgPredictedDrawProbability,
      avgDrawProbOnActualDraws: v11Draw.avgDrawProbOnActualDraws,
      avgDrawProbOnNonDraws: v11Draw.avgDrawProbOnNonDraws,
      drawBrier: v11Draw.drawBrier,
    },
  }
  writeFileSync(join(MODEL_DIR_V11, "calibration.json"), JSON.stringify(calibration, null, 2) + "\n", "utf-8")

  return { status, checks, v1Metrics, v11Metrics }
}

function main(): void {
  const allMatches = loadModelMatches()
  const v1Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))
  const tuningMatches = filterSeasons(allMatches, [BURN_IN_SEASON, ...TUNING_SEASONS_V11])

  console.log(
    `model:v11:tune — ${RHO_VALUES.length}×${DRAW_MASS_VALUES.length}×${GOAL_SCALE_VALUES.length} = ` +
      `${RHO_VALUES.length * DRAW_MASS_VALUES.length * GOAL_SCALE_VALUES.length} cells on ${TUNING_SEASONS_V11.join(", ")}`,
  )

  const results: Candidate[] = []
  let index = 0
  for (const rho of RHO_VALUES) {
    for (const drawMassMultiplier of DRAW_MASS_VALUES) {
      for (const goalScale of GOAL_SCALE_VALUES) {
        const cal: CalibrationParams = { rho, drawMassMultiplier, goalScale }
        const base: Candidate = {
          index,
          rho,
          drawMassMultiplier,
          goalScale,
          config: buildV11Config(v1Config, cal),
          configHash: "",
          logLoss: Number.NaN,
          brierScore: Number.NaN,
          drawBrier: Number.NaN,
          drawRecall: Number.NaN,
          drawPrecision: Number.NaN,
          accuracy1X2: Number.NaN,
          exactScoreAccuracy: Number.NaN,
          totalGoalsMAE: Number.NaN,
          predictedDrawCount: Number.NaN,
          invalidReason: null,
        }
        index++

        try {
          validateCalibration(cal)
        } catch (e) {
          base.invalidReason = e instanceof Error ? e.message : String(e)
          results.push(base)
          continue
        }

        try {
          const preds = runBacktest(tuningMatches, base.config, { evaluateSeasons: TUNING_SEASONS_V11 })
          const metrics = computeMetrics(preds)
          const draw = computeDrawMetrics(preds)
          base.configHash = hashConfig(base.config)
          base.logLoss = metrics.logLoss
          base.brierScore = metrics.brierScore
          base.drawBrier = draw.drawBrier
          base.drawRecall = draw.drawRecall
          base.drawPrecision = draw.drawPrecision
          base.accuracy1X2 = metrics.accuracy1X2
          base.exactScoreAccuracy = metrics.exactScoreAccuracy
          base.totalGoalsMAE = metrics.totalGoalsMAE
          base.predictedDrawCount = draw.predictedDrawCount
        } catch (e) {
          base.invalidReason = e instanceof Error ? e.message : String(e)
        }
        results.push(base)
      }
    }
  }

  const valid = results.filter((r) => r.invalidReason === null)
  const invalid = results.filter((r) => r.invalidReason !== null)
  const best = valid.reduce((acc, r) => (better(r, acc) ? r : acc), valid[0])
  const sorted = [...results].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0))

  mkdirSync(MODEL_DIR_V11, { recursive: true })
  writeFileSync(join(MODEL_DIR_V11, "config.json"), JSON.stringify(best.config, null, 2) + "\n", "utf-8")

  const logLosses = valid.map((r) => r.logLoss)
  const tuningReport = {
    schemaVersion: 1,
    evaluationType: "tuning",
    modelVersion: MODEL_VERSION,
    inputDataHash: inputDataHash(),
    seasons: { burnIn: BURN_IN_SEASON, tuning: TUNING_SEASONS_V11 },
    grid: {
      rho: RHO_VALUES,
      drawMassMultiplier: DRAW_MASS_VALUES,
      goalScale: GOAL_SCALE_VALUES,
      size: results.length,
      valid: valid.length,
      invalid: invalid.length,
    },
    objective: {
      primary: "multiclassLogLoss",
      secondary: "brierScore",
      tertiary: "drawBrier",
      quaternary: "accuracy1X2",
      direction: "minimize (logLoss/Brier/drawBrier), maximize (accuracy)",
      tieBreak: "smaller |rho| + |drawMass-1| + |goalScale-1| → grid order",
    },
    best: {
      configHash: best.configHash,
      logLoss: best.logLoss,
      brierScore: best.brierScore,
      drawBrier: best.drawBrier,
      accuracy1X2: best.accuracy1X2,
      config: best.config,
    },
    gridStats: {
      logLossMin: Math.min(...logLosses),
      logLossMax: Math.max(...logLosses),
      logLossMedian: sorted.filter((r) => r.invalidReason === null)[Math.floor(valid.length / 2)].logLoss,
    },
    results: sorted.map((r) => ({
      rho: r.rho,
      drawMassMultiplier: r.drawMassMultiplier,
      goalScale: r.goalScale,
      configHash: r.configHash || null,
      logLoss: r.logLoss,
      brierScore: r.brierScore,
      drawBrier: r.drawBrier,
      drawRecall: r.drawRecall,
      drawPrecision: r.drawPrecision,
      accuracy1X2: r.accuracy1X2,
      exactScoreAccuracy: r.exactScoreAccuracy,
      totalGoalsMAE: r.totalGoalsMAE,
      predictedDrawCount: r.predictedDrawCount,
      invalidReason: r.invalidReason,
    })),
  }
  writeFileSync(join(MODEL_DIR_V11, "tuning-report.json"), JSON.stringify(tuningReport, null, 2) + "\n", "utf-8")

  console.log(
    `\nbest config (logLoss ${best.logLoss.toFixed(4)}, brier ${best.brierScore.toFixed(4)}, drawBrier ${best.drawBrier.toFixed(4)}, acc ${best.accuracy1X2.toFixed(4)}):`,
  )
  console.log(`  rho=${best.rho} drawMassMultiplier=${best.drawMassMultiplier} goalScale=${best.goalScale}`)
  console.log(`  predictedDraws=${best.predictedDrawCount} drawRecall=${best.drawRecall.toFixed(4)}`)
  console.log(`  configHash=${best.configHash}`)
  console.log(`\nvalid=${valid.length} invalid=${invalid.length} (${invalid.length ? invalid.map((r) => `${r.rho}: ${r.invalidReason}`).join("; ") : "none"})`)

  const { status, checks } = runValidation(allMatches, v1Config, best)
  console.log(`\nvalidation (${VALIDATION_SEASON_V11}) status: ${status}`)
  for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`)

  console.log(`\nwrote ${join(MODEL_DIR_V11, "config.json")}`)
  console.log(`wrote ${join(MODEL_DIR_V11, "tuning-report.json")}`)
  console.log(`wrote ${join(MODEL_DIR_V11, "validation-report.json")}`)
  console.log(`wrote ${join(MODEL_DIR_V11, "calibration.json")}`)
}

main()
