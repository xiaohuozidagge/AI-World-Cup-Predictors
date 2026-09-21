/**
 * v1.2 locked validation — runs 2025-26 EXACTLY ONCE, after the config is frozen
 * and pre-registered, and applies the §八 acceptance criteria.
 *
 * This script only READS the frozen v1.2 config and pre-registration; it never
 * writes config.json. It warms the state on all five seasons (2021-22…2025-26)
 * and evaluates the locked 2025-26 season for v1.2, v1, and v1.1, producing a
 * unified metric report plus a v1.2 reliability (calibration) table.
 *
 * No runtime clock, no network, no randomness.
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
  type DeepPartial,
  type ModelConfig,
  type MatchPrediction,
} from "../lib/model"
import {
  ACCEPTANCE_CRITERIA_V12,
  BURN_IN_SEASON,
  DEVELOPMENT_SEASON_V12,
  filterSeasons,
  inputDataHash,
  loadModelMatches,
  LOCKED_VALIDATION_SEASON_V12,
  MODEL_DIR,
  MODEL_DIR_V11,
  MODEL_DIR_V12,
  readJson,
  SELECTION_SEASON_V12,
  TRAINING_SEASON_V12,
  WARM_SEASONS_FOR_VALIDATION_V12,
} from "./model-inputs"

const MODEL_VERSION = "1.2.0"

interface Check {
  name: string
  pass: boolean
  detail: string
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail }
}

function fail(msg: string): never {
  throw new Error(`model:v12:validate FAILED — ${msg}`)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg)
}

function allProbabilitiesValid(preds: MatchPrediction[]): boolean {
  const tol = ACCEPTANCE_CRITERIA_V12.probSumTolerance
  for (const p of preds) {
    const { home, draw, away } = p.probabilities
    if (!(home >= 0 && draw >= 0 && away >= 0)) return false
    if (Math.abs(home + draw + away - 1) > tol) return false
  }
  return true
}

function drawProbGap(draw: ReturnType<typeof computeDrawMetrics>): number {
  return draw.avgDrawProbOnActualDraws - draw.avgDrawProbOnNonDraws
}

/** A full per-model summary for the unified report (§九). */
function summarize(preds: MatchPrediction[], includeDrawPredictions: boolean) {
  const metrics = computeMetrics(preds)
  const draw = computeDrawMetrics(preds)
  const confidenceBreakdown = computeConfidenceBreakdown(preds)
  const summary = {
    metrics,
    drawMetrics: draw,
    drawProbGap: drawProbGap(draw),
    confidenceBreakdown,
    predictedOutcomeDistribution: predictedOutcomeDistribution(preds),
    actualOutcomeDistribution: actualOutcomeDistribution(preds),
    confusionMatrix: computeConfusionMatrix(preds),
    scorelineDistribution: scorelineDistribution(preds, 10),
    scorelineQuality: computeScorelineQuality(preds, 10),
    calibrationBuckets: calibrationBuckets(preds, 10),
  }
  if (includeDrawPredictions) {
    return {
      ...summary,
      drawPredictions: preds
        .filter((p) => p.predictedResult === "D")
        .map((p) => ({
          matchId: p.matchId,
          homeSlug: p.homeSlug,
          awaySlug: p.awaySlug,
          date: p.date,
          drawProbability: p.probabilities.draw,
        })),
    }
  }
  return summary
}

function runAcceptance(v1Metrics: ReturnType<typeof computeMetrics>, v1Draw: ReturnType<typeof computeDrawMetrics>, v12Preds: MatchPrediction[]): { checks: Check[]; disclosures: string[]; status: string } {
  const c = ACCEPTANCE_CRITERIA_V12
  const v12Metrics = computeMetrics(v12Preds)
  const v12Draw = computeDrawMetrics(v12Preds)
  const v12Confidence = computeConfidenceBreakdown(v12Preds)
  const predDist = predictedOutcomeDistribution(v12Preds)
  const distinctOutcomes = (["H", "D", "A"] as const).filter((o) => predDist[o].count > 0)
  const gap = drawProbGap(v12Draw)

  const mediumMonotonic =
    v12Confidence.medium.count === 0 || v12Confidence.low.count === 0 || v12Confidence.medium.accuracy >= v12Confidence.low.accuracy - c.confidenceTolerance
  const highMonotonic =
    v12Confidence.high.count < c.minHighConfidenceSamples ||
    v12Confidence.medium.count === 0 ||
    v12Confidence.high.accuracy >= v12Confidence.medium.accuracy - c.confidenceTolerance

  const checks: Check[] = [
    check("probabilities_valid", allProbabilitiesValid(v12Preds), "all probabilities in [0,1] and sum to 1"),
    check(
      "predicted_draws_at_least_5pct",
      v12Draw.predictedDrawCount >= c.minPredictedDraws,
      `predicted ${v12Draw.predictedDrawCount} draws (≥ ${c.minPredictedDraws})`,
    ),
    check(
      "no_false_draw_inflation",
      v12Draw.predictedDrawCount <= c.maxPredictedDraws,
      `predicted ${v12Draw.predictedDrawCount} draws (≤ ${c.maxPredictedDraws} = 35%)`,
    ),
    check(
      "draw_recall_ge_010",
      Number.isFinite(v12Draw.drawRecall) && v12Draw.drawRecall >= c.minDrawRecall,
      `draw recall ${v12Draw.drawRecall.toFixed(4)} (≥ ${c.minDrawRecall})`,
    ),
    check(
      "draw_precision_ge_020",
      Number.isFinite(v12Draw.drawPrecision) && v12Draw.drawPrecision >= c.minDrawPrecision,
      `draw precision ${v12Draw.drawPrecision.toFixed(4)} (≥ ${c.minDrawPrecision})`,
    ),
    check(
      "draw_f1_ge_013",
      Number.isFinite(v12Draw.drawF1) && v12Draw.drawF1 >= c.minDrawF1,
      `draw F1 ${v12Draw.drawF1.toFixed(4)} (≥ ${c.minDrawF1})`,
    ),
    check(
      "draw_prob_gap_gt_001",
      Number.isFinite(gap) && gap > c.minDrawProbGap,
      `avg draw prob on draws ${v12Draw.avgDrawProbOnActualDraws.toFixed(4)} vs non-draws ${v12Draw.avgDrawProbOnNonDraws.toFixed(4)} (gap ${gap.toFixed(4)} > ${c.minDrawProbGap})`,
    ),
    check(
      "draw_brier_within_tolerance",
      v12Draw.drawBrier <= v1Draw.drawBrier + c.drawBrierTolerance,
      `v1.2 ${v12Draw.drawBrier.toFixed(4)} vs v1 ${v1Draw.drawBrier.toFixed(4)} (Δ ${(v12Draw.drawBrier - v1Draw.drawBrier).toFixed(4)} ≤ +${c.drawBrierTolerance})`,
    ),
    check(
      "log_loss_within_tolerance",
      v12Metrics.logLoss <= v1Metrics.logLoss + c.logLossTolerance,
      `v1.2 ${v12Metrics.logLoss.toFixed(4)} vs v1 ${v1Metrics.logLoss.toFixed(4)} (Δ ${(v12Metrics.logLoss - v1Metrics.logLoss).toFixed(4)} ≤ +${c.logLossTolerance})`,
    ),
    check(
      "brier_within_tolerance",
      v12Metrics.brierScore <= v1Metrics.brierScore + c.brierTolerance,
      `v1.2 ${v12Metrics.brierScore.toFixed(4)} vs v1 ${v1Metrics.brierScore.toFixed(4)} (Δ ${(v12Metrics.brierScore - v1Metrics.brierScore).toFixed(4)} ≤ +${c.brierTolerance})`,
    ),
    check(
      "accuracy_within_tolerance",
      v12Metrics.accuracy1X2 >= v1Metrics.accuracy1X2 - c.accuracyTolerance,
      `v1.2 ${(v12Metrics.accuracy1X2 * 100).toFixed(2)}% vs v1 ${(v1Metrics.accuracy1X2 * 100).toFixed(2)}% (Δ ${((v12Metrics.accuracy1X2 - v1Metrics.accuracy1X2) * 100).toFixed(2)}pp ≥ −${c.accuracyTolerance * 100}pp)`,
    ),
    check(
      "no_single_category_collapse",
      distinctOutcomes.length >= c.minDistinctOutcomes,
      `predicted distribution H=${predDist.H.count} D=${predDist.D.count} A=${predDist.A.count}`,
    ),
    check(
      "confidence_not_inflated",
      mediumMonotonic && highMonotonic,
      `low ${v12Confidence.low.accuracy.toFixed(4)} / medium ${v12Confidence.medium.accuracy.toFixed(4)} / high ${v12Confidence.high.accuracy.toFixed(4)}`,
    ),
  ]

  const disclosures: string[] = []
  if (v12Confidence.high.count < c.minHighConfidenceSamples) {
    disclosures.push(
      `high-confidence bucket has only ${v12Confidence.high.count} samples (< ${c.minHighConfidenceSamples}); ` +
        "high-confidence accuracy is disclosed but NOT claimed as a stable estimate.",
    )
  }
  checks.push(
    check(
      "high_confidence_disclosed",
      v12Confidence.high.count >= c.minHighConfidenceSamples || disclosures.length > 0,
      `high-confidence samples ${v12Confidence.high.count} (≥ ${c.minHighConfidenceSamples} required to claim stability)`,
    ),
  )

  const gating = checks.slice(0, 13) // checks 1..13 are the §八 acceptance gates
  const status = gating.every((chk) => chk.pass) ? "accepted" : "rejected"
  return { checks, disclosures, status }
}

function main(): void {
  const allMatches = loadModelMatches()

  /* ---- frozen configs + pre-registration ---- */
  const v12Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V12, "config.json")))
  const v1Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))
  const v11Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V11, "config.json")))
  const preReg = readJson<{
    configHash: string
    inputDataHash: string
    selectedFeatureSet: string
    selectedL2: number
    acceptanceCriteria: typeof ACCEPTANCE_CRITERIA_V12
  }>(join(MODEL_DIR_V12, "pre-registration.json"))

  assert(v12Config.version === MODEL_VERSION, `v1.2 config version must be ${MODEL_VERSION}, got ${v12Config.version}`)
  assert(v12Config.drawModel !== undefined, "v1.2 config is missing the draw model")

  const v12Hash = hashConfig(v12Config)
  assert(preReg.configHash === v12Hash, "config.json changed after pre-registration — aborting (would corrupt the freeze)")
  assert(preReg.inputDataHash === inputDataHash(), "input data changed after pre-registration")
  assert(JSON.stringify(preReg.acceptanceCriteria) === JSON.stringify(ACCEPTANCE_CRITERIA_V12), "pre-registered acceptance criteria changed")

  /* ---- run 2025-26 locked validation ONCE ---- */
  const validationMatches = filterSeasons(allMatches, WARM_SEASONS_FOR_VALIDATION_V12)
  const v12Preds = runBacktest(validationMatches, v12Config, { evaluateSeasons: [LOCKED_VALIDATION_SEASON_V12] })
  const v1Preds = runBacktest(validationMatches, v1Config, { evaluateSeasons: [LOCKED_VALIDATION_SEASON_V12] })
  const v11Preds = runBacktest(validationMatches, v11Config, { evaluateSeasons: [LOCKED_VALIDATION_SEASON_V12] })

  const v1Metrics = computeMetrics(v1Preds)
  const v1Draw = computeDrawMetrics(v1Preds)
  const { checks, disclosures, status } = runAcceptance(v1Metrics, v1Draw, v12Preds)

  /* ---- unified report ---- */
  const report = {
    schemaVersion: 1,
    evaluationType: "locked_validation",
    modelVersion: MODEL_VERSION,
    inputDataHash: inputDataHash(),
    configHash: v12Hash,
    configHashV1: hashConfig(v1Config),
    configHashV1_1: hashConfig(v11Config),
    seasons: {
      burnIn: BURN_IN_SEASON,
      training: TRAINING_SEASON_V12,
      selection: SELECTION_SEASON_V12,
      development: DEVELOPMENT_SEASON_V12,
      lockedValidation: LOCKED_VALIDATION_SEASON_V12,
    },
    matchCount: v12Preds.length,
    note:
      "2025-26 is the single LOCKED validation season, run exactly once after the " +
      "config was frozen and pre-registered. No parameter, feature, or threshold " +
      "was changed after this run was observed.",
    status,
    acceptanceCriteria: ACCEPTANCE_CRITERIA_V12,
    checks,
    disclosures,
    models: {
      v1_2: summarize(v12Preds, true),
      v1: summarize(v1Preds, false),
      v1_1: summarize(v11Preds, false),
    },
  }

  mkdirSync(MODEL_DIR_V12, { recursive: true })
  writeFileSync(join(MODEL_DIR_V12, "validation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8")

  /* ---- v1.2 reliability (calibration) table ---- */
  const v12Draw = computeDrawMetrics(v12Preds)
  const calibration = {
    schemaVersion: 1,
    evaluationType: "locked_validation",
    modelVersion: MODEL_VERSION,
    configHash: v12Hash,
    bins: 10,
    outcomes: ["H", "D", "A"] as const,
    bucketCount: 30,
    buckets: calibrationBuckets(v12Preds, 10),
    drawCalibration: {
      actualDrawCount: v12Draw.actualDrawCount,
      avgPredictedDrawProbability: v12Draw.avgPredictedDrawProbability,
      avgDrawProbOnActualDraws: v12Draw.avgDrawProbOnActualDraws,
      avgDrawProbOnNonDraws: v12Draw.avgDrawProbOnNonDraws,
      drawBrier: v12Draw.drawBrier,
      gap: drawProbGap(v12Draw),
    },
  }
  writeFileSync(join(MODEL_DIR_V12, "calibration.json"), JSON.stringify(calibration, null, 2) + "\n", "utf-8")

  const m = report.models.v1_2.metrics
  const d = v12Draw
  console.log(`model:v12:validate — locked ${LOCKED_VALIDATION_SEASON_V12}, ${report.matchCount} matches`)
  console.log(`  status: ${status}`)
  console.log(`  v1.2 1X2 acc ${(m.accuracy1X2 * 100).toFixed(2)}% | logLoss ${m.logLoss.toFixed(4)} | Brier ${m.brierScore.toFixed(4)} | exact ${(m.exactScoreAccuracy * 100).toFixed(2)}%`)
  console.log(`  draws predicted ${d.predictedDrawCount} | recall ${d.drawRecall.toFixed(4)} | precision ${d.drawPrecision.toFixed(4)} | F1 ${d.drawF1.toFixed(4)} | gap ${drawProbGap(d).toFixed(4)}`)
  for (const chk of checks) console.log(`  [${chk.pass ? "PASS" : "FAIL"}] ${chk.name} — ${chk.detail}`)
  if (disclosures.length) for (const dis of disclosures) console.log(`  [NOTE] ${dis}`)
  console.log(`\nwrote validation-report.json, calibration.json under ${MODEL_DIR_V12}`)
}

main()
