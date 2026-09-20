/**
 * Final holdout evaluation. Reads the locked config (`data/model/config.json`),
 * runs a chronological backtest on the independent 2025-26 season (warmed on
 * 2021-22 → 2024-25), and compares the model against three baselines on the
 * same holdout. Writes `holdout-report.json`, `calibration.json`, and the
 * optional `backtest-predictions.json`.
 *
 * Reproducible: metrics are a pure function of the config + history snapshot.
 * No runtime clock, no network, no randomness.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { computeMetrics, hashConfig, resolveConfig, type ModelConfig } from "../lib/model"
import { calibrationBuckets, toSavedPrediction } from "../lib/model"
import { runBacktest, runBaselineAlwaysHome, runBaselineEloOnly, runBaselineLeagueAverage } from "../lib/model"
import {
  HOLDOUT_SEASON,
  inputDataHash,
  loadModelMatches,
  MODEL_DIR,
  readJson,
  TUNING_SEASONS,
} from "./model-inputs"

function main(): void {
  const configPath = join(MODEL_DIR, "config.json")
  if (!existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath} — run model:tune first`)
  }

  const config = resolveConfig(readJson<Partial<ModelConfig>>(configPath))
  const matches = loadModelMatches()
  const holdoutMatches = matches.filter((m) => m.season === HOLDOUT_SEASON)
  const warmupMatches = matches.filter((m) => m.season !== HOLDOUT_SEASON)

  if (holdoutMatches.length === 0) {
    throw new Error(`no matches found for holdout season ${HOLDOUT_SEASON}`)
  }

  const predictions = runBacktest(matches, config, { evaluateSeasons: [HOLDOUT_SEASON] })
  const metrics = computeMetrics(predictions)

  const baselines = {
    alwaysHomeWin: computeMetrics(runBaselineAlwaysHome(holdoutMatches, config)),
    leagueAveragePoisson: computeMetrics(runBaselineLeagueAverage(holdoutMatches, warmupMatches, config)),
    eloOnly: computeMetrics(runBaselineEloOnly(matches, warmupMatches, config, { evaluateSeasons: [HOLDOUT_SEASON] })),
  }

  const buckets = calibrationBuckets(predictions)
  const configHash = hashConfig(config)

  mkdirSync(MODEL_DIR, { recursive: true })

  const report = {
    schemaVersion: 1,
    evaluationType: "historical_backtest",
    modelVersion: config.version,
    seasons: {
      burnIn: "2021-22",
      tuning: TUNING_SEASONS,
      holdout: HOLDOUT_SEASON,
    },
    configHash,
    inputDataHash: inputDataHash(),
    config,
    matchCount: predictions.length,
    metrics,
    baselines,
    calibration: {
      bins: 10,
      outcomes: ["H", "D", "A"],
      bucketCount: buckets.length,
    },
  }

  const reportPath = join(MODEL_DIR, "holdout-report.json")
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8")

  const calibrationPath = join(MODEL_DIR, "calibration.json")
  writeFileSync(
    calibrationPath,
    JSON.stringify({ schemaVersion: 1, evaluationType: "historical_backtest", bins: 10, outcomes: ["H", "D", "A"], bucketCount: buckets.length, buckets }, null, 2) + "\n",
    "utf-8",
  )

  const predictionsPath = join(MODEL_DIR, "backtest-predictions.json")
  writeFileSync(
    predictionsPath,
    JSON.stringify(
      { schemaVersion: 1, evaluationType: "historical_backtest", predictions: predictions.map(toSavedPrediction) },
      null,
      2,
    ) + "\n",
    "utf-8",
  )

  console.log(`model:backtest — holdout ${HOLDOUT_SEASON}, ${predictions.length} matches`)
  console.log(`  1X2 accuracy : ${(metrics.accuracy1X2 * 100).toFixed(2)}%`)
  console.log(`  exact score  : ${(metrics.exactScoreAccuracy * 100).toFixed(2)}%`)
  console.log(`  total-goal MAE: ${metrics.totalGoalsMAE.toFixed(4)}`)
  console.log(`  within ±1 goal: ${(metrics.bothWithinOneGoal * 100).toFixed(2)}%`)
  console.log(`  Brier        : ${metrics.brierScore.toFixed(4)}`)
  console.log(`  log loss     : ${metrics.logLoss.toFixed(4)}`)
  console.log(`  configHash   : ${configHash}`)
  console.log(`\n  baselines (accuracy1X2 / logLoss):`)
  console.log(`    always-home : ${(baselines.alwaysHomeWin.accuracy1X2 * 100).toFixed(2)}% / ${baselines.alwaysHomeWin.logLoss.toFixed(4)}`)
  console.log(`    league-avg  : ${(baselines.leagueAveragePoisson.accuracy1X2 * 100).toFixed(2)}% / ${baselines.leagueAveragePoisson.logLoss.toFixed(4)}`)
  console.log(`    elo-only    : ${(baselines.eloOnly.accuracy1X2 * 100).toFixed(2)}% / ${baselines.eloOnly.logLoss.toFixed(4)}`)

  const beatAlwaysHome = metrics.logLoss <= baselines.alwaysHomeWin.logLoss
  const beatLeagueAvg = metrics.logLoss <= baselines.leagueAveragePoisson.logLoss
  const beatEloOnly = metrics.logLoss <= baselines.eloOnly.logLoss
  console.log(`\n  beats always-home (logLoss): ${beatAlwaysHome}`)
  console.log(`  beats league-avg  (logLoss): ${beatLeagueAvg}`)
  console.log(`  beats elo-only    (logLoss): ${beatEloOnly}`)

  console.log(`\nwrote ${reportPath}`)
  console.log(`wrote ${calibrationPath}`)
  console.log(`wrote ${predictionsPath}`)
}

main()
