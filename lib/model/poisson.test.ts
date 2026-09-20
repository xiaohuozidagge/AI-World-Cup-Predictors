import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "./config"
import { argmaxOneX2, buildScoreMatrix, poissonPmf } from "./poisson"

test("poissonPmf: k=0 is exp(-lambda)", () => {
  assert.ok(Math.abs(poissonPmf(0, 1.5) - Math.exp(-1.5)) < 1e-12)
})

test("poissonPmf: negative lambda is zero", () => {
  assert.equal(poissonPmf(3, -1), 0)
})

test("poissonPmf: sums to ~1 over a wide range", () => {
  let sum = 0
  for (let k = 0; k <= 30; k++) sum += poissonPmf(k, 2.5)
  assert.ok(Math.abs(sum - 1) < 1e-6)
})

test("buildScoreMatrix: re-normalized, sums to 1, finite", () => {
  const m = buildScoreMatrix(1.5, 1.2, DEFAULT_CONFIG)
  const max = DEFAULT_CONFIG.lambda.maxGoals
  assert.equal(m.matrix.length, max + 1)
  assert.equal(m.matrix[0].length, max + 1)

  let total = 0
  for (const row of m.matrix) for (const p of row) total += p
  assert.ok(Math.abs(total - 1) < 1e-9)

  const oneX2 = m.oneX2
  assert.ok(Math.abs(oneX2.home + oneX2.draw + oneX2.away - 1) < 1e-9)
  for (const row of m.matrix) for (const p of row) assert.ok(Number.isFinite(p))
})

test("buildScoreMatrix: top scoreline is the max-probability cell", () => {
  const m = buildScoreMatrix(1.4, 1.1, DEFAULT_CONFIG)
  const top = m.topScoreline
  const pTop = m.matrix[top.home][top.away]
  for (let i = 0; i < m.matrix.length; i++) {
    for (let j = 0; j < m.matrix[i].length; j++) {
      assert.ok(m.matrix[i][j] <= pTop + 1e-12)
    }
  }
})

test("buildScoreMatrix: top-3 scorelines are descending", () => {
  const m = buildScoreMatrix(1.4, 1.1, DEFAULT_CONFIG)
  assert.equal(m.topScorelines.length, 3)
  assert.ok(m.topScorelines[0].probability >= m.topScorelines[1].probability)
  assert.ok(m.topScorelines[1].probability >= m.topScorelines[2].probability)
})

test("argmaxOneX2 returns the largest outcome", () => {
  assert.equal(argmaxOneX2({ home: 0.4, draw: 0.35, away: 0.25 }), "H")
  assert.equal(argmaxOneX2({ home: 0.3, draw: 0.4, away: 0.3 }), "D")
  assert.equal(argmaxOneX2({ home: 0.25, draw: 0.35, away: 0.4 }), "A")
})
