import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "./config"
import { computeConfidence, normalizedEntropy, predictMatch } from "./predictor"
import { initialModelState } from "./backtest"
import type { ModelMatch, OneX2Probabilities } from "./types"

function mm(id: string, date: string, homeSlug: string, awaySlug: string, hg: number, ag: number): ModelMatch {
  return { id, season: "2025-26", date, homeSlug, awaySlug, homeGoals: hg, awayGoals: ag }
}

test("normalizedEntropy: uniform is 1, deterministic is 0", () => {
  assert.ok(Math.abs(normalizedEntropy({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }) - 1) < 1e-9)
  assert.ok(Math.abs(normalizedEntropy({ home: 1, draw: 0, away: 0 })) < 1e-12)
})

test("computeConfidence: strong tiers with a lopsided spread reach high", () => {
  const p: OneX2Probabilities = { home: 0.8, draw: 0.15, away: 0.05 }
  const { level } = computeConfidence(p, "strong", "strong", 60, 60, DEFAULT_CONFIG)
  assert.equal(level, "high")
})

test("computeConfidence: limited tier caps the level at low", () => {
  const p: OneX2Probabilities = { home: 0.8, draw: 0.15, away: 0.05 }
  const { level } = computeConfidence(p, "limited", "strong", 5, 60, DEFAULT_CONFIG)
  assert.equal(level, "low")
})

test("predictMatch: valid probabilities, bounded lambdas, capped reasons", () => {
  const state = initialModelState()
  state.elo.alpha = 1600
  state.elo.beta = 1400
  const pred = predictMatch(mm("m1", "2025-08-16", "alpha", "beta", 2, 1), state, DEFAULT_CONFIG)

  const sum = pred.probabilities.home + pred.probabilities.draw + pred.probabilities.away
  assert.ok(Math.abs(sum - 1) < 1e-9)
  assert.ok(pred.lambdaHome >= DEFAULT_CONFIG.lambda.minLambda && pred.lambdaHome <= DEFAULT_CONFIG.lambda.maxLambda)
  assert.ok(pred.lambdaAway >= DEFAULT_CONFIG.lambda.minLambda && pred.lambdaAway <= DEFAULT_CONFIG.lambda.maxLambda)
  assert.ok(pred.reasons.length >= 1 && pred.reasons.length <= DEFAULT_CONFIG.reasons.maxReasons)
  assert.ok(["low", "medium", "high"].includes(pred.confidence))
  assert.equal(pred.actualResult, "H")
})

test("predictMatch: teams with no history emit the limited-history reason", () => {
  const pred = predictMatch(mm("m2", "2025-08-17", "gamma", "delta", 0, 0), initialModelState(), DEFAULT_CONFIG)
  assert.ok(pred.reasons.some((r) => r.code === "LIMITED_HISTORY"))
})
