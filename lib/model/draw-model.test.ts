import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  applyDrawTarget,
  buildDrawModelConfig,
  diagonalSum,
  predictDrawProbability,
  sigmoid,
  trainLogisticRegression,
  validateDrawModelConfig,
} from "./draw-model"
import { featureNamesFor, featureSetSize, initFeatureState } from "./features"
import { hashConfig, resolveConfig, type ModelConfig } from "./config"
import { initialModelState } from "./backtest"
import { predictMatch } from "./predictor"
import { argmaxOneX2 } from "./poisson"
import type { DrawModelConfig, FeatureSet, ModelMatch } from "./types"

function mm(id: string, season: string, date: string, homeSlug: string, awaySlug: string, hg: number, ag: number): ModelMatch {
  return { id, season, date, homeSlug, awaySlug, homeGoals: hg, awayGoals: ag }
}

/** A draw model with zero weights and zero intercept → qDraw = 0.5 for every match. */
function trivialDrawModel(featureSet: FeatureSet = "A"): DrawModelConfig {
  const d = featureSetSize(featureSet)
  return {
    featureSet,
    l2: 1,
    featureNames: featureNamesFor(featureSet),
    featureMeans: new Array(d).fill(0),
    featureStdDevs: new Array(d).fill(1),
    coefficients: new Array(d).fill(0),
    intercept: 0,
  }
}

const SEPARABLE_X = [
  [1, 1],
  [1, 2],
  [1, 3],
  [1, 4],
  [1, 5],
  [10, 10],
  [10, 11],
  [10, 12],
  [10, 13],
  [10, 14],
]
const SEPARABLE_Y = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]

test("sigmoid is deterministic, symmetric, and bounded in (0,1)", () => {
  assert.equal(sigmoid(0), 0.5)
  assert.ok(sigmoid(100) > 0.9999)
  assert.ok(sigmoid(-100) < 0.0001)
  assert.ok(Math.abs(sigmoid(3) + sigmoid(-3) - 1) < 1e-12)
})

test("training is deterministic — identical inputs give identical coefficients", () => {
  const a = trainLogisticRegression(SEPARABLE_X, SEPARABLE_Y, 1)
  const b = trainLogisticRegression(SEPARABLE_X, SEPARABLE_Y, 1)
  assert.deepEqual(a.coefficients, b.coefficients)
  assert.equal(a.intercept, b.intercept)
})

test("stronger L2 regularization shrinks the coefficient norm", () => {
  const weak = trainLogisticRegression(SEPARABLE_X, SEPARABLE_Y, 0.01)
  const strong = trainLogisticRegression(SEPARABLE_X, SEPARABLE_Y, 10)
  const norm = (c: number[]) => Math.hypot(...c)
  assert.ok(norm(strong.coefficients) < norm(weak.coefficients))
})

test("a zero-weight, zero-intercept model predicts qDraw = 0.5", () => {
  const cfg = trivialDrawModel("C")
  const x = new Array(23).fill(0)
  assert.equal(predictDrawProbability(x, cfg), 0.5)
})

test("applyDrawTarget sets the diagonal sum exactly to qDraw", () => {
  const m = [
    [0.2, 0.1, 0.05],
    [0.1, 0.1, 0.05],
    [0.05, 0.05, 0.3],
  ]
  const out = applyDrawTarget(m, 0.4)
  assert.ok(Math.abs(diagonalSum(out) - 0.4) < 1e-9)
})

test("applyDrawTarget output is re-normalized to sum to 1", () => {
  const m = [
    [0.3, 0.2, 0.1],
    [0.1, 0.1, 0.05],
    [0.05, 0.05, 0.05],
  ]
  const out = applyDrawTarget(m, 0.5)
  let sum = 0
  for (const row of out) for (const p of row) sum += p
  assert.ok(Math.abs(sum - 1) < 1e-12)
})

test("applyDrawTarget preserves diagonal internal ratios", () => {
  const m = [
    [0.2, 0.1, 0.05],
    [0.1, 0.1, 0.05],
    [0.05, 0.05, 0.3],
  ]
  const out = applyDrawTarget(m, 0.4)
  assert.ok(Math.abs(out[0][0] / out[1][1] - m[0][0] / m[1][1]) < 1e-9)
  assert.ok(Math.abs(out[1][1] / out[2][2] - m[1][1] / m[2][2]) < 1e-9)
})

test("applyDrawTarget preserves non-diagonal ratios and the home/away relation", () => {
  const m = [
    [0.2, 0.1, 0.05],
    [0.1, 0.1, 0.05],
    [0.05, 0.05, 0.3],
  ]
  const out = applyDrawTarget(m, 0.4)
  // non-diagonal internal ratios (all off-diagonal cells scale together)
  assert.ok(Math.abs(out[0][1] / out[0][2] - m[0][1] / m[0][2]) < 1e-9)
  assert.ok(Math.abs(out[1][0] / out[2][0] - m[1][0] / m[2][0]) < 1e-9)
  // home-vs-away relation is a non-diagonal ratio and must be preserved too
  assert.ok(Math.abs(out[0][1] / out[1][0] - m[0][1] / m[1][0]) < 1e-9)
})

test("buildDrawModelConfig validates, and structurally invalid configs are rejected", () => {
  const cfg = buildDrawModelConfig("A", 1, [0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0], 0)
  assert.doesNotThrow(() => validateDrawModelConfig(cfg))
  assert.throws(() => validateDrawModelConfig({ ...cfg, featureSet: "D" as FeatureSet }))
  assert.throws(() => validateDrawModelConfig({ ...cfg, l2: 5 }))
  assert.throws(() => validateDrawModelConfig({ ...cfg, featureStdDevs: [1, 1, 1, 1, 1, 0] }))
  assert.throws(() => validateDrawModelConfig({ ...cfg, intercept: NaN }))
  assert.throws(() => validateDrawModelConfig({ ...cfg, coefficients: [0, 0, 0, 0, 0] }))
})

test("predictMatch with an active draw model forces draw = qDraw, stays normalized, and keeps argmax", () => {
  const base = resolveConfig()
  const cfg: ModelConfig = { ...base, version: "1.2.0", drawModel: trivialDrawModel("A") }
  const state = initialModelState()
  const match = mm("m1", "2025-26", "2025-08-16", "alpha", "beta", 1, 1)
  const p = predictMatch(match, state, cfg, {
    config: cfg.drawModel!,
    featureState: initFeatureState(),
    promotedBySeason: {},
  })

  // qDraw = sigmoid(0) = 0.5 forced onto the diagonal sum
  assert.ok(Math.abs(p.probabilities.draw - 0.5) < 1e-9)
  const sum = p.probabilities.home + p.probabilities.draw + p.probabilities.away
  assert.ok(Math.abs(sum - 1) < 1e-9)
  assert.equal(p.predictedResult, argmaxOneX2(p.probabilities))
  // draw (0.5) strictly dominates home and away, so the outcome is a draw
  assert.equal(p.predictedResult, "D")
})

test("v1 config hash is unchanged after the v1.2 changes", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "model", "premier-league", "v1", "config.json"), "utf-8"))
  assert.equal(hashConfig(resolveConfig(raw)), "28b50575b3ceea4dcad6d6d3e581f2895d825c84b82745def1214f9678679680")
})

test("v1.1 config hash is unchanged after the v1.2 changes", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "model", "premier-league", "v1.1", "config.json"), "utf-8"))
  assert.equal(hashConfig(resolveConfig(raw)), "faa04987ac7ea10a0c13ee0b84730047c460e3a650e20604df61e454d3635475")
})

test("repeated training + config assembly yields a stable config hash (no clock/randomness)", () => {
  const X = [
    [1, 0, 1, 0, 1, 0],
    [1, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 1],
    [0, 1, 0, 1, 0, 1],
    [1, 1, 1, 1, 1, 1],
  ]
  const y = [0, 0, 1, 1, 0]
  const build = (): string => {
    const fit = trainLogisticRegression(X, y, 1)
    const drawModel = buildDrawModelConfig("A", 1, new Array(6).fill(0), new Array(6).fill(1), fit.coefficients, fit.intercept)
    const cfg: ModelConfig = { ...resolveConfig(), version: "1.2.0", drawModel }
    return hashConfig(cfg)
  }
  assert.equal(build(), build())
})
