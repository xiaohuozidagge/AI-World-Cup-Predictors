/**
 * Tunes the prediction model over a bounded grid (TUNING_GRID). Evaluates each
 * candidate with a chronological, leakage-free backtest on the tuning seasons
 * (2022-23 → 2024-25) after a 2021-22 burn-in, then selects the config that
 * minimizes multiclass log loss (tie-break: Brier, then 1X2 accuracy, then the
 * simpler/more conservative config). Writes `data/model/config.json` (the
 * locked config) and `data/model/tuning-report.json`.
 *
 * The holdout season (2025-26) is never read here — only `model:backtest` sees
 * it. No runtime clock, no network, no randomness.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { DEFAULT_CONFIG, hashConfig, resolveConfig, TUNING_GRID, type ModelConfig } from "../lib/model"
import { computeMetrics } from "../lib/model"
import { runBacktest } from "../lib/model"
import { inputDataHash, loadModelMatches, MODEL_DIR, TUNING_SEASONS } from "./model-inputs"

const EPS = 1e-9

interface GridResult {
  index: number
  config: ModelConfig
  configHash: string
  logLoss: number
  brierScore: number
  accuracy1X2: number
  kFactor: number
  homeAdvantage: number
  seasonRegression: number
  halfLifeDays: number
  priorStrength: number
  eloToLambda: number
}

function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

/** True if `a` should win over `b` (primary log loss, then Brier, then accuracy, then simplicity). */
function better(a: GridResult, b: GridResult): boolean {
  if (!epsEq(a.logLoss, b.logLoss)) return a.logLoss < b.logLoss
  if (!epsEq(a.brierScore, b.brierScore)) return a.brierScore < b.brierScore
  if (!epsEq(a.accuracy1X2, b.accuracy1X2)) return a.accuracy1X2 > b.accuracy1X2
  const aSimple = (a.eloToLambda === 0 ? 0 : 1) + (a.seasonRegression === 0 ? 0 : 1)
  const bSimple = (b.eloToLambda === 0 ? 0 : 1) + (b.seasonRegression === 0 ? 0 : 1)
  if (aSimple !== bSimple) return aSimple < bSimple
  return a.index < b.index
}

function main(): void {
  const matches = loadModelMatches()
  console.log(`model:tune — ${TUNING_GRID.length} grid cells × ${matches.length} matches (${TUNING_SEASONS.join(", ")})`)

  const results: GridResult[] = []
  for (let i = 0; i < TUNING_GRID.length; i++) {
    const config = resolveConfig(TUNING_GRID[i])
    const predictions = runBacktest(matches, config, { evaluateSeasons: TUNING_SEASONS })
    const metrics = computeMetrics(predictions)

    results.push({
      index: i,
      config,
      configHash: hashConfig(config),
      logLoss: metrics.logLoss,
      brierScore: metrics.brierScore,
      accuracy1X2: metrics.accuracy1X2,
      kFactor: config.elo.kFactor,
      homeAdvantage: config.elo.homeAdvantage,
      seasonRegression: config.elo.seasonRegression,
      halfLifeDays: config.strength.halfLifeDays,
      priorStrength: config.strength.priorStrength,
      eloToLambda: config.lambda.eloToLambda,
    })
  }

  const best = results.reduce((bestSoFar, r) => (better(r, bestSoFar) ? r : bestSoFar), results[0])
  const sorted = [...results].sort((a, b) => {
    if (!epsEq(a.logLoss, b.logLoss)) return a.logLoss - b.logLoss
    if (!epsEq(a.brierScore, b.brierScore)) return a.brierScore - b.brierScore
    if (!epsEq(a.accuracy1X2, b.accuracy1X2)) return b.accuracy1X2 - a.accuracy1X2
    return a.index - b.index
  })

  mkdirSync(MODEL_DIR, { recursive: true })

  const configPath = join(MODEL_DIR, "config.json")
  writeFileSync(configPath, JSON.stringify(best.config, null, 2) + "\n", "utf-8")

  const logLosses = results.map((r) => r.logLoss)
  const report = {
    schemaVersion: 1,
    evaluationType: "tuning",
    modelVersion: DEFAULT_CONFIG.version,
    inputDataHash: inputDataHash(),
    seasons: { burnIn: "2021-22", tuning: TUNING_SEASONS },
    gridSize: results.length,
    objective: {
      primary: "multiclassLogLoss",
      secondary: "brierScore",
      tertiary: "accuracy1X2",
      direction: "minimize",
      tieBreak: "lower brierScore → higher accuracy1X2 → simpler (eloToLambda=0, seasonRegression=0) → grid order",
    },
    best: {
      configHash: best.configHash,
      logLoss: best.logLoss,
      brierScore: best.brierScore,
      accuracy1X2: best.accuracy1X2,
      config: best.config,
    },
    gridStats: {
      logLossMin: Math.min(...logLosses),
      logLossMax: Math.max(...logLosses),
      logLossMedian: sorted[Math.floor(sorted.length / 2)].logLoss,
    },
    results: sorted.map((r, rank) => ({
      rank: rank + 1,
      configHash: r.configHash,
      logLoss: r.logLoss,
      brierScore: r.brierScore,
      accuracy1X2: r.accuracy1X2,
      grid: {
        kFactor: r.kFactor,
        homeAdvantage: r.homeAdvantage,
        seasonRegression: r.seasonRegression,
        halfLifeDays: r.halfLifeDays,
        priorStrength: r.priorStrength,
        eloToLambda: r.eloToLambda,
      },
    })),
  }

  const reportPath = join(MODEL_DIR, "tuning-report.json")
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8")

  console.log(`\nbest config (logLoss ${best.logLoss.toFixed(4)}, brier ${best.brierScore.toFixed(4)}, acc ${best.accuracy1X2.toFixed(4)}):`)
  console.log(`  kFactor=${best.kFactor} homeAdv=${best.homeAdvantage} seasonRegression=${best.seasonRegression}`)
  console.log(`  halfLifeDays=${best.halfLifeDays} priorStrength=${best.priorStrength} eloToLambda=${best.eloToLambda}`)
  console.log(`  configHash=${best.configHash}`)
  console.log(`\nwrote ${configPath}`)
  console.log(`wrote ${reportPath}`)
}

main()
