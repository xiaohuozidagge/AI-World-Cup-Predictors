/**
 * Dixon–Coles low-score correction plus the draw-mass calibration.
 *
 * The independent Poisson model systematically mis-estimates the four lowest
 * scorelines (0-0, 0-1, 1-0, 1-1): the two teams' goal counts are not actually
 * independent, so 0-0 and 1-1 draws are under-stated while 1-0/0-1 one-goal
 * wins are over-stated. Dixon & Coles (1997) re-weight those four cells with a
 * single correlation parameter `rho`; afterwards the full matrix is re-normalized.
 *
 * With the sign convention below, `rho < 0` boosts 0-0 and 1-1 and reduces 0-1
 * and 1-0 (the draw-boosting direction); `rho = 0` reproduces plain Poisson.
 *
 * The draw-mass calibration is applied after Dixon–Coles: every diagonal cell
 * (0-0, 1-1, 2-2, …) is multiplied by `drawMassMultiplier`, then the full
 * matrix is re-normalized, so the final draw probability is exactly the sum of
 * the re-normalized diagonal cells.
 *
 * Pure and deterministic. All parameters come from the config — never hard-coded.
 */

/**
 * Dixon–Coles τ factor for a single cell (x = home goals, y = away goals).
 * τ = 1 for every cell except the four lowest scores.
 */
export function dixonColesTau(
  x: number,
  y: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho
  if (x === 0 && y === 1) return 1 + lambdaHome * rho
  if (x === 1 && y === 0) return 1 + lambdaAway * rho
  if (x === 1 && y === 1) return 1 - rho
  return 1
}

/**
 * Apply the Dixon–Coles correction to an un-normalized score matrix. Returns a
 * new matrix; throws if any corrected cell goes negative (an illegal rho for
 * the given lambdas), so a bad config fails loudly rather than being silently
 * fixed.
 */
export function applyDixonColesCorrection(
  matrix: number[][],
  lambdaHome: number,
  lambdaAway: number,
  rho: number,
): number[][] {
  const out = matrix.map((row, i) =>
    row.map((p, j) => p * dixonColesTau(i, j, lambdaHome, lambdaAway, rho)),
  )
  for (const row of out) {
    for (const p of row) {
      if (p < 0) {
        throw new Error(
          `Dixon–Coles produced a negative probability (rho=${rho}, λh=${lambdaHome}, λa=${lambdaAway})`,
        )
      }
    }
  }
  return out
}

/**
 * Multiply every diagonal (draw) cell by `drawMassMultiplier`. Returns a new
 * matrix. `drawMassMultiplier = 1` returns the matrix unchanged.
 */
export function applyDrawMassMultiplier(matrix: number[][], drawMassMultiplier: number): number[][] {
  if (drawMassMultiplier < 0) {
    throw new Error(`drawMassMultiplier must be >= 0, got ${drawMassMultiplier}`)
  }
  return matrix.map((row, i) => row.map((p, j) => (i === j ? p * drawMassMultiplier : p)))
}
