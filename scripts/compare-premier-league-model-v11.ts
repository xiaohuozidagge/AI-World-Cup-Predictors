/**
 * v1.1 exposed (post-hoc) comparison on 2025-26.
 *
 * 2025-26 is NOT an untouched holdout for v1.1 — v1 was built while observing it,
 * and v1.1 was calibrated specifically to the deficiencies seen there. This
 * script therefore labels the run `exposed_post_hoc_comparison` and compares
 * v1.1 against v1 and three fixed baselines on the same 380 matches.
 *
 * It only READS the locked v1.1 config and never modifies it. Future real
 * prospective accuracy begins with the 2026-27 published, locked pre-match
 * predictions — which this phase does not generate.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  actualOutcomeDistribution,
  computeConfusionMatrix,
  computeConfidenceBreakdown,
  computeDrawMetrics,
  computeMetrics,
  hashConfig,
  predictedOutcomeDistribution,
  resolveConfig,
  runBacktest,
  runBaselineAlwaysHome,
  runBaselineEloOnly,
  runBaselineLeagueAverage,
  scorelineDistribution,
  type DeepPartial,
  type ModelConfig,
} from "../lib/model"
import {
  BURN_IN_SEASON,
  EXPOSED_SEASON_V11,
  filterSeasons,
  inputDataHash,
  loadModelMatches,
  MODEL_DIR,
  MODEL_DIR_V11,
  readJson,
  TUNING_SEASONS_V11,
  VALIDATION_SEASON_V11,
} from "./model-inputs"

const EPS = 1e-12

function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

interface ModelComparison {
  metrics: ReturnType<typeof computeMetrics>
  drawMetrics: ReturnType<typeof computeDrawMetrics>
}

function summarize(preds: ReturnType<typeof runBacktest>): ModelComparison {
  return { metrics: computeMetrics(preds), drawMetrics: computeDrawMetrics(preds) }
}

function main(): void {
  const allMatches = loadModelMatches()
  const exposedMatches = filterSeasons(allMatches, [EXPOSED_SEASON_V11])
  const warmupMatches = filterSeasons(allMatches, [BURN_IN_SEASON, ...TUNING_SEASONS_V11, VALIDATION_SEASON_V11])

  const v11Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V11, "config.json")))
  const v1Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))

  const v11Preds = runBacktest(allMatches, v11Config, { evaluateSeasons: [EXPOSED_SEASON_V11] })
  const v1Preds = runBacktest(allMatches, v1Config, { evaluateSeasons: [EXPOSED_SEASON_V11] })

  const alwaysHome = runBaselineAlwaysHome(exposedMatches, v1Config)
  const leagueAverage = runBaselineLeagueAverage(exposedMatches, warmupMatches, v1Config)
  const eloOnly = runBaselineEloOnly(allMatches, warmupMatches, v1Config, { evaluateSeasons: [EXPOSED_SEASON_V11] })

  // Sanity: v1 recomputed on 2025-26 must reproduce the committed v1 holdout report.
  const v1Holdout = readJson<{ metrics: { accuracy1X2: number; logLoss: number } }>(join(MODEL_DIR, "holdout-report.json"))
  const v1Metrics = computeMetrics(v1Preds)
  if (!epsEq(v1Metrics.accuracy1X2, v1Holdout.metrics.accuracy1X2) || !epsEq(v1Metrics.logLoss, v1Holdout.metrics.logLoss)) {
    throw new Error(
      `v1 recomputation mismatch: acc ${v1Metrics.accuracy1X2} vs ${v1Holdout.metrics.accuracy1X2}, logLoss ${v1Metrics.logLoss} vs ${v1Holdout.metrics.logLoss}`,
    )
  }

  const report = {
    schemaVersion: 1,
    evaluationType: "exposed_post_hoc_comparison",
    modelVersion: "1.1.0",
    inputDataHash: inputDataHash(),
    seasons: {
      burnIn: BURN_IN_SEASON,
      tuning: TUNING_SEASONS_V11,
      validation: VALIDATION_SEASON_V11,
      exposed: EXPOSED_SEASON_V11,
    },
    note:
      "2025-26 is an EXPOSED, post-hoc comparison set — NOT an untouched holdout. " +
      "v1 was built while observing it; v1.1 was calibrated to the deficiencies seen there. " +
      "Real prospective accuracy begins with the 2026-27 published, locked pre-match predictions.",
    configHashV1_1: hashConfig(v11Config),
    configHashV1: hashConfig(v1Config),
    matchCount: exposedMatches.length,
    models: {
      v1_1: {
        ...summarize(v11Preds),
        confidenceBreakdown: computeConfidenceBreakdown(v11Preds),
        predictedOutcomeDistribution: predictedOutcomeDistribution(v11Preds),
        actualOutcomeDistribution: actualOutcomeDistribution(v11Preds),
        confusionMatrix: computeConfusionMatrix(v11Preds),
        scorelineDistribution: scorelineDistribution(v11Preds, 10),
      },
      v1: summarize(v1Preds),
      alwaysHomeWin: summarize(alwaysHome),
      leagueAveragePoisson: summarize(leagueAverage),
      eloOnly: summarize(eloOnly),
    },
  }

  mkdirSync(MODEL_DIR_V11, { recursive: true })
  writeFileSync(join(MODEL_DIR_V11, "exposed-comparison-report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8")

  const m = report.models.v1_1.metrics
  const d = report.models.v1_1.drawMetrics
  console.log(`model:v11:compare — exposed ${EXPOSED_SEASON_V11}, ${report.matchCount} matches (post-hoc, not untouched holdout)`)
  console.log(`  v1.1  1X2 acc ${(m.accuracy1X2 * 100).toFixed(2)}% | logLoss ${m.logLoss.toFixed(4)} | Brier ${m.brierScore.toFixed(4)} | exact ${(m.exactScoreAccuracy * 100).toFixed(2)}% | goalMAE ${m.totalGoalsMAE.toFixed(4)}`)
  console.log(`  draws predicted ${d.predictedDrawCount} | recall ${d.drawRecall.toFixed(4)} | precision ${d.drawPrecision.toFixed(4)} | F1 ${d.drawF1.toFixed(4)}`)
  console.log(`  v1    logLoss ${report.models.v1.metrics.logLoss.toFixed(4)} (reproduces committed holdout)`)
  console.log(`\nwrote ${join(MODEL_DIR_V11, "exposed-comparison-report.json")}`)
}

main()
