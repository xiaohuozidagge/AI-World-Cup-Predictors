/**
 * Pure Poisson score-distribution math. Produces a full, re-normalized score
 * matrix (0..maxGoals × 0..maxGoals) and the 1X2 probabilities derived from it.
 */

import type { ModelConfig } from "./config"
import { calibrationOf } from "./config"
import { applyDixonColesCorrection, applyDrawMassMultiplier } from "./dixon-coles"
import type { OneX2Probabilities, Scoreline } from "./types"

/** Poisson probability mass function P(X = k; λ), computed stably. */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda < 0) return 0
  if (k === 0) return Math.exp(-lambda)
  // exp(k·ln λ − λ − ln k!) via recursion for numeric stability at moderate λ.
  let logP = -lambda + k * Math.log(lambda)
  for (let i = 1; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}

export interface ScoreMatrix {
  /** matrix[i][j] = P(home=i, away=j), re-normalized over the truncated grid. */
  matrix: number[][]
  /** The full scoreline with the single highest probability. */
  topScoreline: Scoreline
  /** The top-3 distinct scorelines, highest probability first. */
  topScorelines: Array<{ home: number; away: number; probability: number }>
  /** 1X2 probabilities summed from the matrix. */
  oneX2: OneX2Probabilities
  /** Raw (pre-normalization) probability mass covered by 0..maxGoals. */
  coverageMass: number
}

/**
 * Build a truncated-and-renormalized Poisson score matrix for the given lambdas.
 * The matrix covers 0..maxGoals goals; truncation is re-normalized so the full
 * matrix sums to exactly 1. Order of operations:
 *
 *   1. independent Poisson cells (0..maxGoals),
 *   2. Dixon–Coles low-score correction (`rho`),
 *   3. draw-mass calibration on the diagonal (`drawMassMultiplier`),
 *   4. re-normalize the full matrix,
 *   5. read 1X2 and the top scoreline from the corrected matrix.
 *
 * With `rho = 0` and `drawMassMultiplier = 1` this reproduces v1 exactly.
 * Never returns NaN/Infinity — lambdas are clamped by the caller.
 */
export function buildScoreMatrix(lambdaHome: number, lambdaAway: number, config: ModelConfig): ScoreMatrix {
  const max = config.lambda.maxGoals
  const cal = calibrationOf(config)
  const rows: number[][] = []
  let total = 0
  for (let i = 0; i <= max; i++) {
    const row: number[] = []
    const ph = poissonPmf(i, lambdaHome)
    for (let j = 0; j <= max; j++) {
      const p = ph * poissonPmf(j, lambdaAway)
      row.push(p)
      total += p
    }
    rows.push(row)
  }

  // Dixon–Coles low-score correction, then draw-mass calibration on the diagonal.
  const corrected = applyDixonColesCorrection(rows, lambdaHome, lambdaAway, cal.rho)
  const boosted = applyDrawMassMultiplier(corrected, cal.drawMassMultiplier)

  // Re-normalize the corrected, truncated matrix so probabilities sum to 1.
  let sum = 0
  for (const row of boosted) for (const p of row) sum += p
  const norm = sum > 0 ? 1 / sum : 0
  const matrix = boosted.map((row) => row.map((p) => p * norm))

  return readScoreMatrix(matrix, total)
}

/**
 * Read 1X2 probabilities, the top scoreline, and the top-3 scorelines from an
 * already-normalized score matrix. `coverageMass` is the pre-normalization mass
 * (unchanged by any post-hoc rescaling, so it is carried through verbatim).
 */
export function readScoreMatrix(matrix: number[][], coverageMass: number): ScoreMatrix {
  const max = matrix.length - 1
  let home = 0
  let draw = 0
  let away = 0
  const all: Array<{ home: number; away: number; probability: number }> = []
  for (let i = 0; i <= max; i++) {
    for (let j = 0; j <= max; j++) {
      const p = matrix[i][j]
      all.push({ home: i, away: j, probability: p })
      if (i > j) home += p
      else if (i === j) draw += p
      else away += p
    }
  }

  all.sort((a, b) => b.probability - a.probability || a.home - b.home || a.away - b.away)

  const topScorelines = all.slice(0, 3).map(({ home: h, away: a, probability }) => ({ home: h, away: a, probability }))

  return {
    matrix,
    topScoreline: { home: all[0].home, away: all[0].away },
    topScorelines,
    oneX2: { home, draw, away },
    coverageMass,
  }
}

/** Return the 1X2 outcome (argmax) for a set of probabilities. */
export function argmaxOneX2(p: OneX2Probabilities): "H" | "D" | "A" {
  if (p.home >= p.draw && p.home >= p.away) return "H"
  if (p.draw >= p.away) return "D"
  return "A"
}
