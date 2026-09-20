import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG, resolveConfig } from "./config"
import { expectedHomeScore, initialElo, predictionRatingDiff, regressEloToMean, updateEloAfterMatch } from "./elo"

test("expectedHomeScore: equal ratings split 0.5", () => {
  assert.equal(expectedHomeScore(1500, 1500), 0.5)
})

test("expectedHomeScore: symmetric complement", () => {
  assert.ok(Math.abs(expectedHomeScore(1580, 1420) + expectedHomeScore(1420, 1580) - 1) < 1e-9)
})

test("expectedHomeScore: stronger home gets more than half", () => {
  assert.ok(expectedHomeScore(1650, 1450) > 0.5)
})

test("predictionRatingDiff adds home advantage", () => {
  assert.equal(predictionRatingDiff(1500, 1500, DEFAULT_CONFIG), DEFAULT_CONFIG.elo.homeAdvantage)
})

test("initialElo returns config initial rating", () => {
  assert.equal(initialElo(DEFAULT_CONFIG), 1500)
})

test("updateEloAfterMatch: home win by two scales K and moves ratings", () => {
  const elo: Record<string, number> = {}
  updateEloAfterMatch(elo, "alpha", "beta", 2, 0, DEFAULT_CONFIG)
  // K = 20 * (1 + 0.2*1) = 24; delta = 24 * (1 - 0.5) = 12.
  assert.equal(elo.alpha, 1512)
  assert.equal(elo.beta, 1488)
})

test("updateEloAfterMatch: draw leaves equal ratings unchanged", () => {
  const elo: Record<string, number> = {}
  updateEloAfterMatch(elo, "alpha", "beta", 1, 1, DEFAULT_CONFIG)
  assert.equal(elo.alpha, 1500)
  assert.equal(elo.beta, 1500)
})

test("updateEloAfterMatch: away win lowers the home rating", () => {
  const elo: Record<string, number> = { alpha: 1500, beta: 1500 }
  updateEloAfterMatch(elo, "alpha", "beta", 0, 1, DEFAULT_CONFIG)
  assert.ok(elo.alpha < 1500)
  assert.ok(elo.beta > 1500)
})

test("regressEloToMean pulls ratings toward the mean", () => {
  const config = resolveConfig({ elo: { seasonRegression: 0.5 } })
  const elo: Record<string, number> = { a: 1700, b: 1300 }
  regressEloToMean(elo, config)
  assert.equal(elo.a, 1600)
  assert.equal(elo.b, 1400)
})
