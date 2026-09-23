/**
 * Official-accuracy eligibility (Phase VIII). A prediction only counts toward
 * the official accuracy if it was sealed AND published before kickoff, is not a
 * backtest, was not cancelled/voided, and its sealed snapshot hash verifies.
 * Official accuracy reads only the sealed final snapshot — never the Phase VII
 * original candidates, never a later recomputation, never a backtest, and never
 * an unpublished or post-kickoff-published prediction.
 */

import type { Result } from "../model/types"

export type PredictionState = "historical_reconstruction" | "post_event_reconstruction" | "unlocked" | "sealed" | "published"

export interface EligibilityContext {
  predictionType: "backtest" | "candidate"
  predictionState: PredictionState
  sealedAt: string | null
  publishedAt: string | null
  kickoffUtc: string
  cancelled: boolean
  sealHashVerified: boolean
  /** Late backtests are permanently ineligible — later results can never restore them. */
  permanentlyIneligible?: boolean
}

/** Whether a single prediction is eligible for official accuracy. */
export function isEligibleForOfficialAccuracy(ctx: EligibilityContext): boolean {
  if (ctx.permanentlyIneligible === true) return false
  if (ctx.predictionType === "backtest") return false
  if (ctx.predictionState !== "published") return false
  if (ctx.cancelled) return false
  if (!ctx.sealHashVerified) return false
  if (ctx.sealedAt === null || ctx.publishedAt === null) return false
  return Date.parse(ctx.sealedAt) < Date.parse(ctx.kickoffUtc) && Date.parse(ctx.publishedAt) < Date.parse(ctx.kickoffUtc)
}

/* --------------------------- sealed-snapshot accuracy --------------------------- */

export interface SealedSnapshotMatch {
  id: string
  predictionType: "candidate"
  predictionState: "sealed" | "published"
  predictedResult: Result
  eligibleForOfficialAccuracy: boolean
}

export interface OfficialAccuracy {
  count: number
  correct: number
  accuracy: number | null
}

/**
 * Compute official accuracy over a sealed snapshot only. Ignores any match that
 * is not eligible for official accuracy; among eligible matches, only finished
 * results (present in `results`) are scored. `null` when no eligible match.
 */
export function computeOfficialAccuracy(
  snapshot: SealedSnapshotMatch[],
  results: Map<string, Result>,
): OfficialAccuracy {
  const eligible = snapshot.filter((m) => m.eligibleForOfficialAccuracy)
  let correct = 0
  for (const m of eligible) {
    const actual = results.get(m.id)
    if (actual !== undefined && m.predictedResult === actual) correct++
  }
  return { count: eligible.length, correct, accuracy: eligible.length === 0 ? null : correct / eligible.length }
}

/* --------------------------- separate evaluation --------------------------- */

export interface MatchEvaluation {
  id: string
  adjusted: boolean
  /** The sealed final predicted result (post-adjustment, if any). */
  officialPredictedResult: Result
  /** The original v1 model predicted result (pre-adjustment). */
  originalModelPredictedResult: Result
}

export interface SeparateEvaluation {
  officialLockedCount: number
  officialLockedAccuracy: number | null
  originalModelCount: number
  originalModelAccuracy: number | null
  manuallyAdjustedCount: number
}

/**
 * Evaluate the sealed final snapshot and the original model prediction side by
 * side, so manual adjustments can never mask the model's true performance.
 */
export function evaluateSeparately(
  matches: MatchEvaluation[],
  results: Map<string, Result>,
): SeparateEvaluation {
  let officialCorrect = 0
  let originalCorrect = 0
  for (const m of matches) {
    const actual = results.get(m.id)
    if (actual === undefined) continue
    if (m.officialPredictedResult === actual) officialCorrect++
    if (m.originalModelPredictedResult === actual) originalCorrect++
  }
  const n = matches.length
  return {
    officialLockedCount: n,
    officialLockedAccuracy: n === 0 ? null : officialCorrect / n,
    originalModelCount: n,
    originalModelAccuracy: n === 0 ? null : originalCorrect / n,
    manuallyAdjustedCount: matches.filter((m) => m.adjusted).length,
  }
}
