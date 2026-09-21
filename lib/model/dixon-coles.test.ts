import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG, resolveConfig } from "./config"
import {
  applyDixonColesCorrection,
  applyDrawMassMultiplier,
  dixonColesTau,
} from "./dixon-coles"
import { buildScoreMatrix } from "./poisson"

const LAMBDA_HOME = 1.5
const LAMBDA_AWAY = 1.2

function sampleMatrix(): number[][] {
  // A tiny 2×2 matrix with distinct values; the shape is all the correction needs.
  return [
    [0.1, 0.2],
    [0.3, 0.4],
  ]
}

test("dixonColesTau: rho=0 is 1 for every cell (plain Poisson)", () => {
  for (let i = 0; i <= 3; i++) {
    for (let j = 0; j <= 3; j++) {
      assert.equal(dixonColesTau(i, j, LAMBDA_HOME, LAMBDA_AWAY, 0), 1)
    }
  }
})

test("dixonColesTau: only the four lowest scorelines are corrected", () => {
  // 2-0, 0-2, 2-1, etc. are untouched regardless of rho.
  assert.equal(dixonColesTau(2, 0, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.equal(dixonColesTau(0, 2, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.equal(dixonColesTau(2, 1, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.equal(dixonColesTau(1, 2, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.equal(dixonColesTau(3, 3, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  // The four low scores are corrected.
  assert.notEqual(dixonColesTau(0, 0, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.notEqual(dixonColesTau(0, 1, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.notEqual(dixonColesTau(1, 0, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
  assert.notEqual(dixonColesTau(1, 1, LAMBDA_HOME, LAMBDA_AWAY, -0.2), 1)
})

test("dixonColesTau: negative rho boosts draws and reduces one-goal wins", () => {
  const rho = -0.1
  assert.ok(dixonColesTau(0, 0, LAMBDA_HOME, LAMBDA_AWAY, rho) > 1) // 0-0 boosted
  assert.ok(dixonColesTau(1, 1, LAMBDA_HOME, LAMBDA_AWAY, rho) > 1) // 1-1 boosted
  assert.ok(dixonColesTau(0, 1, LAMBDA_HOME, LAMBDA_AWAY, rho) < 1) // 0-1 reduced
  assert.ok(dixonColesTau(1, 0, LAMBDA_HOME, LAMBDA_AWAY, rho) < 1) // 1-0 reduced
})

test("applyDixonColesCorrection: rho=0 returns an equal matrix", () => {
  const m = sampleMatrix()
  const out = applyDixonColesCorrection(m, LAMBDA_HOME, LAMBDA_AWAY, 0)
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      assert.equal(out[i][j], m[i][j])
    }
  }
})

test("applyDixonColesCorrection: throws on a negative cell (illegal rho for lambda)", () => {
  assert.throws(() => applyDixonColesCorrection(sampleMatrix(), 3, 3, -0.4))
})

test("applyDrawMassMultiplier: multiplier=1 returns an equal matrix", () => {
  const m = sampleMatrix()
  const out = applyDrawMassMultiplier(m, 1)
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      assert.equal(out[i][j], m[i][j])
    }
  }
})

test("applyDrawMassMultiplier: boosts only the diagonal and rejects negatives", () => {
  const m = sampleMatrix()
  const out = applyDrawMassMultiplier(m, 2)
  assert.equal(out[0][0], m[0][0] * 2)
  assert.equal(out[1][1], m[1][1] * 2)
  assert.equal(out[0][1], m[0][1]) // off-diagonal untouched
  assert.equal(out[1][0], m[1][0])
  assert.throws(() => applyDrawMassMultiplier(m, -1))
})

test("buildScoreMatrix: neutral calibration reproduces v1", () => {
  const neutral = resolveConfig({ calibration: { rho: 0, drawMassMultiplier: 1, goalScale: 1 } })
  const a = buildScoreMatrix(LAMBDA_HOME, LAMBDA_AWAY, DEFAULT_CONFIG)
  const b = buildScoreMatrix(LAMBDA_HOME, LAMBDA_AWAY, neutral)
  assert.deepEqual(b.oneX2, a.oneX2)
  assert.deepEqual(b.topScoreline, a.topScoreline)
})

test("buildScoreMatrix: draw probability equals the diagonal sum after correction", () => {
  const config = resolveConfig({ calibration: { rho: -0.15, drawMassMultiplier: 1.2, goalScale: 1 } })
  const m = buildScoreMatrix(LAMBDA_HOME, LAMBDA_AWAY, config)
  let diag = 0
  for (let i = 0; i < m.matrix.length; i++) diag += m.matrix[i][i]
  assert.ok(Math.abs(m.oneX2.draw - diag) < 1e-9)

  let total = 0
  for (const row of m.matrix) for (const p of row) total += p
  assert.ok(Math.abs(total - 1) < 1e-9)
  for (const row of m.matrix) for (const p of row) assert.ok(p >= 0)
})

test("buildScoreMatrix: boosting draw mass never decreases the draw probability", () => {
  const neutral = resolveConfig({ calibration: { rho: 0, drawMassMultiplier: 1, goalScale: 1 } })
  const boosted = resolveConfig({ calibration: { rho: 0, drawMassMultiplier: 1.25, goalScale: 1 } })
  const a = buildScoreMatrix(LAMBDA_HOME, LAMBDA_AWAY, neutral)
  const b = buildScoreMatrix(LAMBDA_HOME, LAMBDA_AWAY, boosted)
  assert.ok(b.oneX2.draw >= a.oneX2.draw - 1e-12)
})
