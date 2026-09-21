/**
 * The v1.2 per-match draw model: a small, deterministic L2-regularized logistic
 * regression that maps pre-match features to a target draw probability `qDraw`,
 * plus the score-matrix integration that sets a match's draw probability to
 * `qDraw` while preserving all intra-matrix structure.
 *
 * Everything here is pure and deterministic — no `Math.random`, no `Date.now`,
 * no random initialization. Training uses Newton's method (Fisher scoring) with
 * a zero weight start and fixed iteration budget, so repeated runs produce
 * bit-identical coefficients.
 */

import type { DrawModelConfig, FeatureSet } from "./types"
import { featureNamesFor, featureSetSize } from "./features"

/** Numerically stable logistic sigmoid. */
export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z)
    return 1 / (1 + e)
  }
  const e = Math.exp(z)
  return e / (1 + e)
}

/** Gaussian elimination with partial pivoting (deterministic, in-place copy). */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-14) {
      throw new Error("draw-model: singular Hessian while training logistic regression")
    }
    if (piv !== col) {
      const tmp = M[piv]
      M[piv] = M[col]
      M[col] = tmp
    }
    const pv = M[col][col]
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / pv
      if (f === 0) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c]
    x[r] = s / M[r][r]
  }
  return x
}

export interface TrainedLogisticModel {
  coefficients: number[]
  intercept: number
}

/**
 * Fit an L2-regularized logistic regression on standardized features. The
 * intercept is not regularized. Deterministic: zero init, Newton steps, fixed
 * iteration budget. `X` is n×d, `y` is 0/1.
 */
export function trainLogisticRegression(
  X: number[][],
  y: number[],
  l2: number,
  options: { maxIter?: number; tol?: number } = {},
): TrainedLogisticModel {
  const n = X.length
  const d = X[0]?.length ?? 0
  if (n === 0 || d === 0) return { coefficients: new Array(d).fill(0), intercept: 0 }
  const maxIter = options.maxIter ?? 100
  const tol = options.tol ?? 1e-9

  // w = [coefficients..., intercept]
  const w = new Array<number>(d + 1).fill(0)

  for (let iter = 0; iter < maxIter; iter++) {
    const p = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      let z = w[d]
      for (let j = 0; j < d; j++) z += w[j] * X[i][j]
      p[i] = sigmoid(z)
    }

    const g = new Array<number>(d + 1).fill(0)
    const H: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0))
    for (let i = 0; i < n; i++) {
      const err = p[i] - y[i]
      const wi = p[i] * (1 - p[i])
      g[d] += err / n
      H[d][d] += wi / n
      for (let j = 0; j < d; j++) {
        const xj = X[i][j]
        g[j] += (err * xj) / n
        H[d][j] += (wi * xj) / n
        H[j][d] += (wi * xj) / n
        for (let k = 0; k <= j; k++) {
          H[j][k] += (wi * xj * X[i][k]) / n
        }
      }
    }
    for (let j = 0; j < d; j++) {
      g[j] += l2 * w[j]
      H[j][j] += l2
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) H[k][j] = H[j][k]

    const delta = solveLinearSystem(H, g)
    let maxDelta = 0
    for (let j = 0; j <= d; j++) {
      w[j] -= delta[j]
      maxDelta = Math.max(maxDelta, Math.abs(delta[j]))
    }
    if (maxDelta < tol) break
  }

  return { coefficients: w.slice(0, d), intercept: w[d] }
}

/** Sigmoid of (coefficients · x + intercept) — the draw probability qDraw. */
export function predictDrawProbability(standardizedFeatures: number[], cfg: DrawModelConfig): number {
  let z = cfg.intercept
  for (let j = 0; j < standardizedFeatures.length; j++) {
    z += cfg.coefficients[j] * standardizedFeatures[j]
  }
  return sigmoid(z)
}

/**
 * Set a score matrix's total draw probability (the diagonal sum) to `qDraw`
 * exactly, preserving every intra-matrix structure (§七):
 *
 *   diagonalScale     = qDraw / baseDraw
 *   nonDiagonalScale  = (1 − qDraw) / (1 − baseDraw)
 *
 * All diagonal cells × diagonalScale; all non-diagonal cells × nonDiagonalScale;
 * then a final numerical re-normalization. This keeps (1) the relative ratios
 * among diagonal cells, (2) the relative ratios among non-diagonal cells, and
 * (3) the home-vs-away relationship (both are non-diagonal and scale together),
 * while (4) the final draw probability equals the diagonal sum = qDraw and
 * (5) H+D+A = 1. Only a tiny 1e-12 guard is used, never a large truncation.
 */
export function applyDrawTarget(matrix: number[][], qDraw: number): number[][] {
  const EPS = 1e-12
  const n = matrix.length
  let baseDraw = 0
  for (let i = 0; i < n; i++) baseDraw += matrix[i][i]

  const q = Math.min(Math.max(qDraw, EPS), 1 - EPS)
  const base = Math.min(Math.max(baseDraw, EPS), 1 - EPS)
  const diagonalScale = q / base
  const nonDiagonalScale = (1 - q) / (1 - base)

  const out = matrix.map((row, i) => row.map((p, j) => (i === j ? p * diagonalScale : p * nonDiagonalScale)))

  let sum = 0
  for (const row of out) for (const p of row) sum += p
  const inv = sum > 0 ? 1 / sum : 0
  return out.map((row) => row.map((p) => p * inv))
}

/** Diagonal sum of a (normalized) score matrix — its draw probability. */
export function diagonalSum(matrix: number[][]): number {
  let s = 0
  for (let i = 0; i < matrix.length; i++) s += matrix[i][i]
  return s
}

/** Assemble a frozen draw-model config from a fit. */
export function buildDrawModelConfig(
  featureSet: FeatureSet,
  l2: number,
  means: number[],
  stdDevs: number[],
  coefficients: number[],
  intercept: number,
): DrawModelConfig {
  return {
    featureSet,
    l2,
    featureNames: featureNamesFor(featureSet),
    featureMeans: means,
    featureStdDevs: stdDevs,
    coefficients,
    intercept,
  }
}

const ALLOWED_L2 = [0.01, 0.1, 1, 10]

/** Reject a structurally invalid draw-model config up front. */
export function validateDrawModelConfig(cfg: DrawModelConfig): void {
  if (cfg.featureSet !== "A" && cfg.featureSet !== "B" && cfg.featureSet !== "C") {
    throw new Error(`drawModel.featureSet must be A/B/C, got ${cfg.featureSet}`)
  }
  if (!ALLOWED_L2.includes(cfg.l2)) {
    throw new Error(`drawModel.l2 must be one of ${ALLOWED_L2.join("/")}, got ${cfg.l2}`)
  }
  const d = featureSetSize(cfg.featureSet)
  if (cfg.featureNames.length !== d) {
    throw new Error(`drawModel.featureNames length ${cfg.featureNames.length} != ${d}`)
  }
  if (cfg.featureMeans.length !== d || cfg.featureStdDevs.length !== d || cfg.coefficients.length !== d) {
    throw new Error(`drawModel arrays must all have length ${d}`)
  }
  if (!Number.isFinite(cfg.intercept)) throw new Error("drawModel.intercept must be finite")
  for (const arr of [cfg.featureMeans, cfg.featureStdDevs, cfg.coefficients]) {
    for (const v of arr) if (!Number.isFinite(v)) throw new Error("drawModel has a non-finite array entry")
  }
  for (const s of cfg.featureStdDevs) if (s <= 0) throw new Error("drawModel.featureStdDevs must be > 0")
}
