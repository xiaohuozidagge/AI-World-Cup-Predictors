/**
 * Verifies the tuned model and its holdout artifacts are internally consistent,
 * reproducible, and leakage-free. Re-runs the holdout backtest from the locked
 * config and asserts it reproduces `holdout-report.json` exactly, then checks
 * calibration totals, config validity, and the absence of odds/future-info
 * fields. Exits non-zero on any failure.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { computeMetrics, hashConfig, resolveConfig, type ModelConfig } from "../lib/model"
import { calibrationBuckets } from "../lib/model"
import { runBacktest } from "../lib/model"
import {
  HOLDOUT_SEASON,
  inputDataHash,
  loadModelMatches,
  MODEL_DIR,
  readJson,
} from "./model-inputs"

interface HoldoutReport {
  configHash: string
  inputDataHash: string
  evaluationType: string
  matchCount: number
  metrics: {
    accuracy1X2: number
    exactScoreAccuracy: number
    homeGoalsMAE: number
    awayGoalsMAE: number
    totalGoalsMAE: number
    bothWithinOneGoal: number
    brierScore: number
    logLoss: number
  }
}

interface CalibrationFile {
  bucketCount: number
  buckets: Array<{ predictions: number }>
}

interface SavedPredictionsFile {
  evaluationType: string
  predictions: Array<{
    matchId: string
    probabilities: { home: number; draw: number; away: number }
    predictedResult: string
    actualResult: string
    predictedScoreline: { home: number; away: number }
    lambdaHome: number
    lambdaAway: number
  }>
}

const EPS = 1e-12

function fail(msg: string): never {
  throw new Error(`model:verify FAILED — ${msg}`)
}

function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg)
}

function assertFinite(n: number, label: string): void {
  assert(Number.isFinite(n), `${label} is not finite: ${n}`)
}

function assertValidConfig(config: ModelConfig): void {
  assert(typeof config.version === "string" && config.version.length > 0, "config.version missing")
  assert(config.elo.initialRating > 0, "elo.initialRating must be > 0")
  assert(config.elo.kFactor > 0, "elo.kFactor must be > 0")
  assert(config.elo.homeAdvantage >= 0, "elo.homeAdvantage must be >= 0")
  assert(config.elo.seasonRegression >= 0 && config.elo.seasonRegression <= 1, "elo.seasonRegression out of [0,1]")
  assert(config.elo.goalDiffFactor >= 0, "elo.goalDiffFactor must be >= 0")
  assert(config.strength.halfLifeDays > 0, "strength.halfLifeDays must be > 0")
  assert(config.strength.priorStrength > 0, "strength.priorStrength must be > 0")
  for (const tier of ["strong", "medium", "limited", "none"] as const) {
    assert(config.strength.priorStrengthMultiplier[tier] > 0, `priorStrengthMultiplier.${tier} must be > 0`)
  }
  assert(config.coverage.limitedMaxMatches >= 0, "coverage.limitedMaxMatches must be >= 0")
  assert(config.coverage.mediumMaxMatches >= config.coverage.limitedMaxMatches, "coverage.mediumMaxMatches < limitedMaxMatches")
  assert(config.lambda.leagueHomeGoals > 0 && config.lambda.leagueAwayGoals > 0, "league goal averages must be > 0")
  assert(config.lambda.minLambda > 0, "lambda.minLambda must be > 0")
  assert(config.lambda.maxLambda >= config.lambda.minLambda, "lambda.maxLambda < minLambda")
  assert(config.lambda.eloToLambda >= 0, "lambda.eloToLambda must be >= 0")
  assert(config.lambda.maxEloDiff > 0, "lambda.maxEloDiff must be > 0")
  assert(config.lambda.maxGoals >= 1, "lambda.maxGoals must be >= 1")
  const w = config.confidence.weights
  assert(w.pMax > 0 && w.entropy > 0 && w.margin > 0 && w.sample > 0, "confidence weights must be positive")
  assert(config.confidence.thresholds.medium < config.confidence.thresholds.high, "confidence thresholds must be ordered")
  for (const tier of ["strong", "medium", "limited", "none"] as const) {
    assert(["low", "medium", "high"].includes(config.confidence.capByTier[tier]), `capByTier.${tier} invalid`)
  }
  assert(config.reasons.maxReasons >= 1, "reasons.maxReasons must be >= 1")
}

function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

function main(): void {
  const configPath = join(MODEL_DIR, "config.json")
  const reportPath = join(MODEL_DIR, "holdout-report.json")
  const calibrationPath = join(MODEL_DIR, "calibration.json")
  const predictionsPath = join(MODEL_DIR, "backtest-predictions.json")

  assert(existsSync(configPath), "config.json missing (run model:tune)")
  assert(existsSync(reportPath), "holdout-report.json missing (run model:backtest)")
  assert(existsSync(calibrationPath), "calibration.json missing (run model:backtest)")

  const config = resolveConfig(readJson<Partial<ModelConfig>>(configPath))
  assertValidConfig(config)

  const report = readJson<HoldoutReport>(reportPath)
  const configHash = hashConfig(config)
  assert(report.configHash === configHash, `report configHash mismatch: ${report.configHash} vs ${configHash}`)
  assert(report.inputDataHash === inputDataHash(), "report inputDataHash mismatch")
  assert(report.evaluationType === "historical_backtest", "report evaluationType must be historical_backtest")
  assert(report.matchCount === 380, `holdout matchCount must be 380, got ${report.matchCount}`)

  // Reproducibility: re-run the backtest and assert identical metrics.
  const matches = loadModelMatches()
  const predictions = runBacktest(matches, config, { evaluateSeasons: [HOLDOUT_SEASON] })
  const metrics = computeMetrics(predictions)

  const fields: Array<
    "accuracy1X2" | "exactScoreAccuracy" | "homeGoalsMAE" | "awayGoalsMAE" | "totalGoalsMAE" | "bothWithinOneGoal" | "brierScore" | "logLoss"
  > = [
    "accuracy1X2",
    "exactScoreAccuracy",
    "homeGoalsMAE",
    "awayGoalsMAE",
    "totalGoalsMAE",
    "bothWithinOneGoal",
    "brierScore",
    "logLoss",
  ]
  for (const f of fields) {
    const expected = report.metrics[f]
    const actual = metrics[f]
    assertFinite(expected, `report.metrics.${f}`)
    assert(epsEq(expected, actual), `metrics.${f} not reproducible: report=${expected} recomputed=${actual}`)
  }

  // Calibration: 30 buckets (3 outcomes × 10 bins), counts sum to 3 × matchCount.
  const buckets = calibrationBuckets(predictions)
  const cal = readJson<CalibrationFile>(calibrationPath)
  assert(cal.bucketCount === buckets.length, `calibration bucketCount mismatch`)
  assert(cal.bucketCount === 30, `calibration bucketCount must be 30, got ${cal.bucketCount}`)
  assert(Array.isArray(cal.buckets) && cal.buckets.length === 30, "calibration.json must contain 30 buckets")
  const totalCount = cal.buckets.reduce((s: number, b: { predictions: number }) => s + b.predictions, 0)
  assert(totalCount === predictions.length * 3, `calibration total predictions ${totalCount} != ${predictions.length * 3}`)

  // Optional saved predictions: each match's 1X2 probabilities sum to ~1.
  if (existsSync(predictionsPath)) {
    const saved = readJson<SavedPredictionsFile>(predictionsPath)
    assert(saved.evaluationType === "historical_backtest", "backtest-predictions evaluationType must be historical_backtest")
    assert(saved.predictions.length === 380, `backtest-predictions must have 380 entries, got ${saved.predictions.length}`)
    for (const p of saved.predictions) {
      const sum = p.probabilities.home + p.probabilities.draw + p.probabilities.away
      assert(epsEq(sum, 1), `prediction ${p.matchId} probabilities sum to ${sum}`)
      assert(p.predictedResult === "H" || p.predictedResult === "D" || p.predictedResult === "A", `bad predictedResult for ${p.matchId}`)
      assert(p.actualResult === "H" || p.actualResult === "D" || p.actualResult === "A", `bad actualResult for ${p.matchId}`)
      assert(p.predictedScoreline.home >= 0 && p.predictedScoreline.away >= 0, `bad scoreline for ${p.matchId}`)
      assert(p.lambdaHome >= config.lambda.minLambda && p.lambdaHome <= config.lambda.maxLambda, `lambdaHome out of range for ${p.matchId}`)
      assert(p.lambdaAway >= config.lambda.minLambda && p.lambdaAway <= config.lambda.maxLambda, `lambdaAway out of range for ${p.matchId}`)
      // Leakage check: no odds fields may exist on any saved prediction.
      const forbidden = ["odds", "b365", "psh", "psd", "psa", "avgH", "avgD", "avgA", "xG", "xg"]
      for (const key of Object.keys(p)) {
        assert(!forbidden.includes(key.toLowerCase()), `leaked field "${key}" on ${p.matchId}`)
      }
    }
  }

  // Chronological check on the live predictions (no future info absorbed early).
  let lastDate = ""
  for (const p of predictions) {
    assert(p.date >= lastDate, `predictions not chronological at ${p.date}`)
    lastDate = p.date
    assertFinite(p.probabilities.home + p.probabilities.draw + p.probabilities.away, `probabilities for ${p.matchId}`)
  }

  console.log("model:verify — all checks passed")
  console.log(`  config valid, configHash ${configHash.slice(0, 12)}…`)
  console.log(`  holdout ${report.matchCount} matches, metrics reproducible`)
  console.log(`  calibration ${cal.bucketCount} buckets, totals consistent`)
  console.log(`  no odds / future-info leakage detected`)
}

main()
