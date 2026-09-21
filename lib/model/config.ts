/**
 * Model configuration: every tunable parameter lives here, never as a magic
 * number inside a function. `DEFAULT_CONFIG` is the baseline; the tune script
 * enumerates a bounded grid over a subset of these fields and selects the
 * combination that minimizes multiclass log loss on the tuning seasons.
 */

import { createHash } from "node:crypto"
import type { ConfidenceLevel, CoverageTier, DrawModelConfig } from "./types"

/** Recursive partial (nested fields may be omitted, e.g. a single Elo parameter). */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/**
 * v1.1 calibration parameters. All three default to "no correction" so a config
 * that omits them reproduces v1 Poisson behaviour exactly.
 */
export interface CalibrationParams {
  /** Dixon–Coles low-score correlation (0 = plain Poisson). */
  rho: number
  /** Multiplier on the diagonal (draw) scoreline cells, applied after Dixon–Coles. */
  drawMassMultiplier: number
  /** Multiplier on expected goals for both sides, applied before the score matrix. */
  goalScale: number
}

/** The neutral calibration that reproduces v1 behaviour. */
export const NEUTRAL_CALIBRATION: CalibrationParams = {
  rho: 0,
  drawMassMultiplier: 1,
  goalScale: 1,
}

/** Read the effective calibration, defaulting to neutral when absent. */
export function calibrationOf(config: ModelConfig): CalibrationParams {
  return config.calibration ?? NEUTRAL_CALIBRATION
}

/**
 * Reject out-of-range calibration values up front so an illegal config fails
 * loudly rather than producing silently negative or degenerate probabilities.
 */
export function validateCalibration(c: CalibrationParams): void {
  if (!Number.isFinite(c.rho) || c.rho < -0.5 || c.rho > 0.5) {
    throw new Error(`calibration.rho out of range [-0.5, 0.5]: ${c.rho}`)
  }
  if (!Number.isFinite(c.drawMassMultiplier) || c.drawMassMultiplier < 0) {
    throw new Error(`calibration.drawMassMultiplier must be >= 0: ${c.drawMassMultiplier}`)
  }
  if (!Number.isFinite(c.goalScale) || c.goalScale <= 0) {
    throw new Error(`calibration.goalScale must be > 0: ${c.goalScale}`)
  }
}

export interface ModelConfig {
  /** Semantic version of the model config. */
  version: string

  elo: {
    initialRating: number
    kFactor: number
    /** Elo points added to the home team for prediction only (never stored). */
    homeAdvantage: number
    /** Fraction (0..1) each rating is pulled toward the mean at season boundaries. */
    seasonRegression: number
    /** Extra K multiplier per goal beyond a 1-goal margin, capped. */
    goalDiffFactor: number
  }

  strength: {
    /** Half-life (days) of the exponential time-decay on strength aggregates. */
    halfLifeDays: number
    /** Base prior-equivalent match count for shrinkage toward league average. */
    priorStrength: number
    /** Multiplier on priorStrength by coverage tier (more shrinkage for less data). */
    priorStrengthMultiplier: Record<CoverageTier, number>
  }

  coverage: {
    /** ≤ this many observed matches → "limited" (1 season). */
    limitedMaxMatches: number
    /** ≤ this many observed matches → "medium" (1–3 seasons); above → "strong". */
    mediumMaxMatches: number
  }

  lambda: {
    /** League-average home goals, used only as a seed before any data is seen. */
    leagueHomeGoals: number
    leagueAwayGoals: number
    minLambda: number
    maxLambda: number
    /** Log-λ multiplier per Elo point (limited Elo→goals adjustment). */
    eloToLambda: number
    /** Elo difference clamp (both directions) for the goals adjustment. */
    maxEloDiff: number
    /** Score matrix covers 0..maxGoals goals. */
    maxGoals: number
  }

  confidence: {
    weights: { pMax: number; entropy: number; margin: number; sample: number }
    thresholds: { medium: number; high: number }
    /** Hard ceiling on the confidence level per coverage tier. */
    capByTier: Record<CoverageTier, ConfidenceLevel>
  }

  reasons: {
    maxReasons: number
  }

  /**
   * v1.1 calibration knobs (optional so v1 configs hash identically without
   * them). Absent ⇔ neutral ⇔ v1 Poisson behaviour.
   */
  calibration?: CalibrationParams

  /**
   * v1.2 per-match draw model (optional so v1/v1.1 configs hash identically
   * without it). Absent ⇔ no draw adjustment ⇔ plain v1/v1.1 behaviour.
   */
  drawModel?: DrawModelConfig
}

export const DEFAULT_CONFIG: ModelConfig = {
  version: "1.0.0",
  elo: {
    initialRating: 1500,
    kFactor: 20,
    homeAdvantage: 65,
    seasonRegression: 0.25,
    goalDiffFactor: 0.2,
  },
  strength: {
    halfLifeDays: 180,
    priorStrength: 20,
    priorStrengthMultiplier: { strong: 1, medium: 1.5, limited: 2.5, none: 100 },
  },
  coverage: {
    limitedMaxMatches: 38,
    mediumMaxMatches: 114,
  },
  lambda: {
    leagueHomeGoals: 1.5,
    leagueAwayGoals: 1.2,
    minLambda: 0.1,
    maxLambda: 5.0,
    eloToLambda: 0.0015,
    maxEloDiff: 200,
    maxGoals: 10,
  },
  confidence: {
    weights: { pMax: 0.45, entropy: 0.2, margin: 0.2, sample: 0.15 },
    thresholds: { medium: 0.55, high: 0.7 },
    capByTier: { strong: "high", medium: "medium", limited: "low", none: "low" },
  },
  reasons: {
    maxReasons: 5,
  },
}

/** Deterministic SHA-256 fingerprint of a config (used in reports). */
export function hashConfig(config: ModelConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex")
}

/** The bounded grid the tune script searches. Every value is enumerated here. */
export const TUNING_GRID: DeepPartial<ModelConfig>[] = buildGrid()

function buildGrid(): DeepPartial<ModelConfig>[] {
  const eloK = [15, 25, 40]
  const homeAdv = [50, 65, 80]
  const seasonRegression = [0, 0.25, 0.5]
  const halfLife = [120, 180, 365]
  const priorStrength = [10, 25, 50]
  const eloToLambda = [0, 0.001, 0.002]

  const grid: DeepPartial<ModelConfig>[] = []
  for (const kFactor of eloK)
    for (const homeAdvantage of homeAdv)
      for (const sr of seasonRegression)
        for (const halfLifeDays of halfLife)
          for (const ps of priorStrength)
            for (const e2l of eloToLambda)
              grid.push({
                elo: { kFactor, homeAdvantage, seasonRegression: sr },
                strength: { halfLifeDays, priorStrength: ps },
                lambda: { eloToLambda: e2l },
              })
  return grid
}

/** Merge a partial config (grid cell) over the defaults into a full config. */
export function resolveConfig(partial?: DeepPartial<ModelConfig>): ModelConfig {
  if (!partial) return DEFAULT_CONFIG
  const p = partial
  const strength = p.strength
  const confidence = p.confidence
  const calibration = p.calibration
  const resolved: ModelConfig = {
    ...DEFAULT_CONFIG,
    ...p,
    elo: { ...DEFAULT_CONFIG.elo, ...p.elo },
    strength: {
      ...DEFAULT_CONFIG.strength,
      ...strength,
      priorStrengthMultiplier: { ...DEFAULT_CONFIG.strength.priorStrengthMultiplier, ...strength?.priorStrengthMultiplier },
    },
    coverage: { ...DEFAULT_CONFIG.coverage, ...p.coverage },
    lambda: { ...DEFAULT_CONFIG.lambda, ...p.lambda },
    confidence: {
      weights: { ...DEFAULT_CONFIG.confidence.weights, ...confidence?.weights },
      thresholds: { ...DEFAULT_CONFIG.confidence.thresholds, ...confidence?.thresholds },
      capByTier: { ...DEFAULT_CONFIG.confidence.capByTier, ...confidence?.capByTier },
    },
    reasons: { ...DEFAULT_CONFIG.reasons, ...p.reasons },
  }
  // Only attach calibration when it is present, so v1 configs (which lack the
  // field) serialize to the identical object and keep the same config hash.
  if (calibration) {
    resolved.calibration = { ...NEUTRAL_CALIBRATION, ...calibration }
  }
  // Same rule for the v1.2 draw model: attach verbatim only when present, so a
  // config without it serializes identically to v1/v1.1.
  if (p.drawModel) {
    resolved.drawModel = p.drawModel
  }
  return resolved
}
