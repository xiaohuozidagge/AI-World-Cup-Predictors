import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "./config"
import {
  groupMatchesByDate,
  runBacktest,
  runBaselineAlwaysHome,
  runBaselineEloOnly,
  runBaselineLeagueAverage,
} from "./backtest"
import type { ModelMatch } from "./types"

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
