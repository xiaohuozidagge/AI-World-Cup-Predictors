import { test } from "node:test"
import assert from "node:assert/strict"

import {
  calibrationBuckets,
  computeConfusionMatrix,
  computeDrawMetrics,
  computeMetrics,
  computeScorelineQuality,
  scorelineDistribution,
  toSavedPrediction,
} from "./metrics"
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

test("computeDrawMetrics: counts, precision, recall, and F1 are correct", () => {
  const tp = pred({ matchId: "tp", actualResult: "D", actualHomeGoals: 1, actualAwayGoals: 1, predictedResult: "D", predictedScoreline: { home: 1, away: 1 } })
  const fn = pred({ matchId: "fn", actualResult: "D", actualHomeGoals: 0, actualAwayGoals: 0, predictedResult: "H" })
  const fp = pred({ matchId: "fp", actualResult: "H", actualHomeGoals: 1, actualAwayGoals: 0, predictedResult: "D" })
  const tn = pred({ matchId: "tn", actualResult: "H", actualHomeGoals: 2, actualAwayGoals: 1, predictedResult: "H" })

  const d = computeDrawMetrics([tp, fn, fp, tn])
  assert.equal(d.actualDrawCount, 2)
  assert.equal(d.predictedDrawCount, 2)
  assert.equal(d.drawPrecision, 0.5) // tp / (tp + fp)
  assert.equal(d.drawRecall, 0.5) // tp / (tp + fn)
  assert.equal(d.drawF1, 0.5)
  // Exact-score split: tp (1-1) and fp (1-0) are exact; fn and tn are not.
  assert.equal(d.exactScoreAccuracyOnDraws, 0.5)
  assert.equal(d.exactScoreAccuracyOnNonDraws, 0.5)
})

test("computeDrawMetrics: no draws at all yields NaN precision/recall (not 0)", () => {
  const a = pred({ matchId: "a", actualResult: "H" })
  const b = pred({ matchId: "b", actualResult: "A", actualHomeGoals: 0, actualAwayGoals: 1 })
  const d = computeDrawMetrics([a, b])
  assert.equal(d.predictedDrawCount, 0)
  assert.equal(d.actualDrawCount, 0)
  assert.ok(Number.isNaN(d.drawPrecision))
  assert.ok(Number.isNaN(d.drawRecall))
  assert.ok(Number.isNaN(d.drawF1))
})

test("computeConfusionMatrix: totals match and entries are placed correctly", () => {
  const m = computeConfusionMatrix([
    pred({ matchId: "a", actualResult: "H", predictedResult: "H" }),
    pred({ matchId: "b", actualResult: "D", actualHomeGoals: 1, actualAwayGoals: 1, predictedResult: "D" }),
    pred({ matchId: "c", actualResult: "A", actualHomeGoals: 0, actualAwayGoals: 2, predictedResult: "A" }),
    pred({ matchId: "d", actualResult: "D", actualHomeGoals: 0, actualAwayGoals: 0, predictedResult: "H" }),
  ])
  assert.equal(m.H.H, 1)
  assert.equal(m.H.D, 1) // predicted H but actually a draw
  assert.equal(m.D.D, 1)
  assert.equal(m.A.A, 1)
  let total = 0
  for (const row of Object.values(m)) for (const c of Object.values(row)) total += c
  assert.equal(total, 4)
})

test("scorelineDistribution: returns top scorelines sorted by count and capped", () => {
  const preds = [
    pred({ matchId: "a", predictedScoreline: { home: 1, away: 0 } }),
    pred({ matchId: "b", predictedScoreline: { home: 1, away: 0 } }),
    pred({ matchId: "c", predictedScoreline: { home: 1, away: 1 } }),
    pred({ matchId: "d", predictedScoreline: { home: 2, away: 0 } }),
  ]
  const dist = scorelineDistribution(preds, 2)
  assert.equal(dist.length, 2)
  assert.deepEqual(dist[0], { home: 1, away: 0, count: 2 })
})

test("computeScorelineQuality: distinct count, fractions, and goal bias", () => {
  const preds = [
    pred({ matchId: "a", predictedScoreline: { home: 1, away: 1 }, lambdaHome: 1.2, lambdaAway: 0.8, actualHomeGoals: 1, actualAwayGoals: 1 }),
    pred({ matchId: "b", predictedScoreline: { home: 1, away: 1 }, lambdaHome: 1.2, lambdaAway: 0.8, actualHomeGoals: 2, actualAwayGoals: 0 }),
    pred({ matchId: "c", predictedScoreline: { home: 1, away: 0 }, lambdaHome: 1.4, lambdaAway: 0.6, actualHomeGoals: 1, actualAwayGoals: 0 }),
    pred({ matchId: "d", predictedScoreline: { home: 2, away: 0 }, lambdaHome: 1.6, lambdaAway: 0.5, actualHomeGoals: 2, actualAwayGoals: 1 }),
  ]
  const q = computeScorelineQuality(preds)
  assert.equal(q.distinctScorelineCount, 3) // 1-1, 1-0, 2-0
  assert.equal(q.oneOneFraction, 0.5) // two of four are 1-1
  assert.equal(q.drawScorelineFractions["1-1"], 0.5)
  assert.equal(q.oneGoalScorelineFractions["1-0"], 0.25)
  assert.equal(q.avgPredictedHomeGoals, (1.2 + 1.2 + 1.4 + 1.6) / 4)
  assert.equal(q.avgActualAwayGoals, (1 + 0 + 0 + 1) / 4)
  assert.ok(Math.abs(q.homeGoalBias - (q.avgPredictedHomeGoals - q.avgActualHomeGoals)) < 1e-12)
  assert.ok(Number.isFinite(q.totalGoalBias))
})
