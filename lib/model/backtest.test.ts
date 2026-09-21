import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG, resolveConfig } from "./config"
import { argmaxOneX2 } from "./poisson"
import {
  groupMatchesByDate,
  runBacktest,
  runBaselineAlwaysHome,
  runBaselineEloOnly,
  runBaselineLeagueAverage,
} from "./backtest"
import type { ModelMatch } from "./types"
import {
  TUNING_SEASONS_V11,
  VALIDATION_SEASON_V11,
  EXPOSED_SEASON_V11,
  TRAINING_SEASON_V12,
  SELECTION_SEASON_V12,
  DEVELOPMENT_SEASON_V12,
  LOCKED_VALIDATION_SEASON_V12,
  V12_FEATURE_SETS,
  V12_L2_VALUES,
} from "../../scripts/model-inputs"

function mm(id: string, season: string, date: string, homeSlug: string, awaySlug: string, hg: number, ag: number): ModelMatch {
  return { id, season, date, homeSlug, awaySlug, homeGoals: hg, awayGoals: ag }
}

test("groupMatchesByDate sorts chronologically and groups by date", () => {
  const matches = [
    mm("b", "2022-23", "2022-08-14", "x", "y", 1, 0),
    mm("a", "2022-23", "2022-08-13", "p", "q", 2, 2),
    mm("c", "2022-23", "2022-08-13", "r", "s", 0, 0),
  ]
  const groups = groupMatchesByDate(matches)
  assert.equal(groups.length, 2)
  assert.equal(groups[0][0], "2022-08-13")
  assert.equal(groups[0][1].length, 2)
  assert.equal(groups[1][0], "2022-08-14")
})

test("runBacktest: same-day matches are predicted before any same-day update", () => {
  const matches = [
    mm("m1", "2022-23", "2022-01-01", "alpha", "beta", 3, 0),
    mm("m2", "2022-23", "2022-01-01", "alpha", "gamma", 0, 0),
    mm("m3", "2022-23", "2022-01-02", "alpha", "delta", 1, 0),
  ]
  const predictions = runBacktest(matches, DEFAULT_CONFIG, { evaluateSeasons: ["2022-23"] })

  assert.equal(predictions.length, 3)
  // Both same-day predictions see an empty alpha state (no leakage).
  assert.equal(predictions[0].homeStrength.matchesObserved, 0)
  assert.equal(predictions[1].homeStrength.matchesObserved, 0)
  // The next day alpha has absorbed both prior matches.
  assert.equal(predictions[2].homeStrength.matchesObserved, 2)
})

test("runBacktest: only evaluate seasons produce predictions", () => {
  const matches = [
    mm("w1", "2021-22", "2021-08-13", "a", "b", 1, 0),
    mm("w2", "2021-22", "2021-08-14", "c", "d", 0, 1),
    mm("e1", "2022-23", "2022-08-13", "a", "c", 1, 1),
  ]
  const predictions = runBacktest(matches, DEFAULT_CONFIG, { evaluateSeasons: ["2022-23"] })
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].season, "2022-23")
})

test("runBaselineAlwaysHome predicts a home win every time", () => {
  const matches = [mm("m1", "2025-26", "2025-08-15", "a", "b", 0, 2), mm("m2", "2025-26", "2025-08-15", "c", "d", 1, 1)]
  const preds = runBaselineAlwaysHome(matches, DEFAULT_CONFIG)
  assert.ok(preds.every((p) => p.predictedResult === "H"))
  assert.ok(preds.every((p) => p.probabilities.home === 1))
})

test("runBaselineLeagueAverage uses constant lambdas across matches", () => {
  const warmup = [mm("w", "2024-25", "2024-08-10", "a", "b", 2, 0), mm("w2", "2024-25", "2024-08-11", "c", "d", 0, 0)]
  const holdout = [mm("h1", "2025-26", "2025-08-15", "a", "b", 1, 0), mm("h2", "2025-26", "2025-08-16", "c", "d", 0, 1)]
  const preds = runBaselineLeagueAverage(holdout, warmup, DEFAULT_CONFIG)
  assert.equal(preds.length, 2)
  assert.equal(preds[0].lambdaHome, preds[1].lambdaHome)
  assert.equal(preds[0].lambdaAway, preds[1].lambdaAway)
})

test("runBaselineEloOnly warms on prior seasons and predicts holdout", () => {
  const warmup = [mm("w", "2024-25", "2024-08-10", "a", "b", 3, 0)]
  const holdout = [mm("h1", "2025-26", "2025-08-15", "a", "b", 1, 0)]
  const preds = runBaselineEloOnly([...warmup, ...holdout], warmup, DEFAULT_CONFIG, { evaluateSeasons: ["2025-26"] })
  assert.equal(preds.length, 1)
  assert.equal(preds[0].season, "2025-26")
  assert.ok(preds[0].lambdaHome >= DEFAULT_CONFIG.lambda.minLambda)
})

test("runBacktest: predictedResult is always the argmax of the probabilities (no forced draws)", () => {
  // A draw-boosted config must not hard-code any number of draws; the outcome
  // is whatever the corrected probabilities say is most likely.
  const config = resolveConfig({ calibration: { rho: -0.2, drawMassMultiplier: 1.25, goalScale: 1 } })
  const matches = [
    mm("m1", "2022-23", "2022-08-13", "alpha", "beta", 0, 0),
    mm("m2", "2022-23", "2022-08-13", "gamma", "delta", 3, 0),
    mm("m3", "2022-23", "2022-08-14", "alpha", "gamma", 1, 1),
    mm("m4", "2022-23", "2022-08-14", "beta", "delta", 0, 2),
  ]
  const predictions = runBacktest(matches, config, { evaluateSeasons: ["2022-23"] })
  assert.equal(predictions.length, 4)
  for (const p of predictions) {
    assert.equal(p.predictedResult, argmaxOneX2(p.probabilities))
  }
})

test("v1.1 partition constants never route 2025-26 into tuning or validation", () => {
  assert.deepEqual(TUNING_SEASONS_V11, ["2022-23", "2023-24"])
  assert.equal(VALIDATION_SEASON_V11, "2024-25")
  assert.equal(EXPOSED_SEASON_V11, "2025-26")
  assert.ok(!TUNING_SEASONS_V11.includes("2025-26"))
  assert.ok(!TUNING_SEASONS_V11.includes("2024-25"))
  assert.ok(!TUNING_SEASONS_V11.includes(VALIDATION_SEASON_V11))
})

test("v1.2 partition constants keep 2025-26 strictly out of training and selection", () => {
  assert.equal(TRAINING_SEASON_V12, "2022-23")
  assert.equal(SELECTION_SEASON_V12, "2023-24")
  assert.equal(DEVELOPMENT_SEASON_V12, "2024-25")
  assert.equal(LOCKED_VALIDATION_SEASON_V12, "2025-26")
  // The locked validation season never appears in any earlier role.
  const locked: string = LOCKED_VALIDATION_SEASON_V12
  assert.ok(TRAINING_SEASON_V12 !== locked)
  assert.ok(SELECTION_SEASON_V12 !== locked)
  assert.ok(DEVELOPMENT_SEASON_V12 !== locked)
  // The search grid is exactly the pre-registered 3 × 4 = 12 combinations.
  assert.deepEqual(V12_FEATURE_SETS, ["A", "B", "C"])
  assert.deepEqual(V12_L2_VALUES, [0.01, 0.1, 1, 10])
})
