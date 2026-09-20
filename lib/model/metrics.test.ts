import { test } from "node:test"
import assert from "node:assert/strict"

import { calibrationBuckets, computeMetrics, toSavedPrediction } from "./metrics"
import type { MatchPrediction } from "./types"

const NEUTRAL = { homeAttack: 1, awayAttack: 1, homeDefense: 1, awayDefense: 1, matchesObserved: 38, tier: "strong" as const }

function pred(overrides: Partial<MatchPrediction>): MatchPrediction {
  return {
    matchId: "m",
    season: "2025-26",
    date: "2025-08-15",
    homeSlug: "a",
    awaySlug: "b",
    actualHomeGoals: 1,
    actualAwayGoals: 0,
    actualResult: "H",
    lambdaHome: 1,
    lambdaAway: 0,
    probabilities: { home: 1, draw: 0, away: 0 },
    predictedResult: "H",
    predictedScoreline: { home: 1, away: 0 },
    topScorelines: [{ home: 1, away: 0, probability: 0.4 }],
    confidence: "high",
    confidenceScore: 0.9,
    reasons: [],
    eloHome: 1600,
    eloAway: 1400,
    eloDiff: 265,
    homeStrength: NEUTRAL,
    awayStrength: NEUTRAL,
    ...overrides,
  }
}

test("computeMetrics: a perfect prediction scores perfectly", () => {
  const m = computeMetrics([pred({})])
  assert.equal(m.accuracy1X2, 1)
  assert.equal(m.exactScoreAccuracy, 1)
  assert.equal(m.brierScore, 0)
  assert.ok(Math.abs(m.logLoss) < 1e-12)
  assert.equal(m.homeGoalsMAE, 0)
  assert.equal(m.awayGoalsMAE, 0)
  assert.equal(m.totalGoalsMAE, 0)
  assert.equal(m.bothWithinOneGoal, 1)
})

test("computeMetrics: mixed predictions yield 0.5 accuracy", () => {
  const wrong = pred({ matchId: "w", actualResult: "D", actualHomeGoals: 0, actualAwayGoals: 0 })
  const m = computeMetrics([pred({}), wrong])
  assert.equal(m.accuracy1X2, 0.5)
  assert.equal(m.matchCount, 2)
})

test("computeMetrics: log loss penalizes a confident miss", () => {
  const miss = pred({ probabilities: { home: 0.9, draw: 0.05, away: 0.05 }, actualResult: "D", actualHomeGoals: 0, actualAwayGoals: 0 })
  const m = computeMetrics([miss])
  assert.ok(m.logLoss > 2) // -log(0.05) ≈ 3
})

test("calibrationBuckets returns 30 buckets with matching totals", () => {
  const preds = [pred({}), pred({ matchId: "b" }), pred({ matchId: "c" })]
  const buckets = calibrationBuckets(preds)
  assert.equal(buckets.length, 30)
  const total = buckets.reduce((s, b) => s + b.predictions, 0)
  assert.equal(total, preds.length * 3)
})

test("toSavedPrediction drops debug-only fields", () => {
  const saved = toSavedPrediction(pred({}))
  assert.equal(saved.matchId, "m")
  assert.ok(!("reasons" in saved))
  assert.ok(!("eloHome" in saved))
})
