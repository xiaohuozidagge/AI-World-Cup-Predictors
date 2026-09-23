/**
 * Season-wide prediction sealing (Phase VIII). Turns the 340 Phase VII candidate
 * predictions into a single "season_publication" seal batch that can never be
 * regenerated per-match. This module is pure and deterministic: no I/O, no clock
 * of its own (the caller injects `sealedAt`), no randomness. It reuses the v1
 * prediction shapes from `lib/model/prediction-artifact` and never re-implements
 * a prediction formula.
 */

import { sha256Hex, type PredictionArtifact } from "../model/prediction-artifact"
import type { Result } from "../model/types"

/* --------------------------- hashing --------------------------- */

/**
 * Deterministic JSON serialization with recursively sorted object keys. Unlike
 * `JSON.stringify`, the output is independent of key insertion order, so it is
 * a safe basis for content hashing.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "undefined") return "null"
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v)).join(",") + "]"
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",") + "}"
}

/** SHA-256 over the canonical (sorted-key) serialization of a value. */
export function hashObject(value: unknown): string {
  return sha256Hex(stableStringify(value))
}

/* --------------------------- clock --------------------------- */

/** Injectable time source. Production uses the real UTC clock; tests use fixed. */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

/* --------------------------- policy --------------------------- */

export type SealMode = "season_publication" | "remaining_future_season_publication"

export interface LockPolicy {
  schemaVersion: 1
  competitionSlug: string
  season: string
  sealMode: SealMode
  modelVersion: string
  allowRegenerationAfterSeal: boolean
  allowAdjustmentAfterSeal: boolean
  requiresPublicationBeforeOfficialEvaluation: boolean
  backtestsEligibleForOfficialAccuracy: boolean
}

/** The fixed season-publication policy: seal once, never regenerate/adjust after. */
export function buildLockPolicy(competitionSlug: string, season: string, sealMode: SealMode = "season_publication"): LockPolicy {
  return {
    schemaVersion: 1,
    competitionSlug,
    season,
    sealMode,
    modelVersion: "1.0.0",
    allowRegenerationAfterSeal: false,
    allowAdjustmentAfterSeal: false,
    requiresPublicationBeforeOfficialEvaluation: true,
    backtestsEligibleForOfficialAccuracy: false,
  }
}

/* --------------------------- sealed shape --------------------------- */

/** A candidate prediction snapshot whose state is now `sealed`. */
export interface SealedPredictionSnapshot extends Omit<PredictionArtifact, "predictionState"> {
  predictionState: "sealed"
}

export interface SealedPrediction {
  id: string
  slug: string
  kickoffUtc: string
  predictionType: "candidate"
  predictionState: "sealed"
  sealedAt: string
  publishedAt: null
  eligibleForOfficialAccuracy: false
  adjusted: boolean
  revision: number
  originalPredictionHash: string
  finalPredictionHash: string
  /** The original model predicted result, retained so the original model can be
   *  evaluated separately from any manual adjustment. */
  originalPredictedResult: Result
  prediction: SealedPredictionSnapshot
}

export interface SealedPredictionsFile {
  schemaVersion: 1
  competitionSlug: string
  season: string
  sealMode: SealMode
  sealedAt: string
  batchHash: string
  backtests: { excluded: true; count: number; note: string }
  counts: {
    totalPredictions: number
    backtestCount: number
    sealedCandidateCount: number
    publishedPredictionCount: number
  }
  candidates: SealedPrediction[]
}

export interface SealManifest {
  schemaVersion: 1
  competitionSlug: string
  season: string
  sealMode: SealMode
  sealedAt: string
  sourceCommit: string
  sourcePredictionsHash: string
  eligibilityOverridesHash: string
  adjustmentLedgerHash: string
  sealedPredictionsHash: string
  effectiveCatalogHash: string
  totalPredictions: number
  originalBacktestCount: number
  lateBacktestCount: number
  totalBacktestCount: number
  sealedCandidateCount: number
  manualAdjustmentCount: number
  publishedPredictionCount: number
  officialPredictionCount: number
  officialAccuracy: null
}

/* --------------------------- blocking --------------------------- */

/** Error carrying exactly which candidates had already started at seal time. */
export class SealBlockedError extends Error {
  constructor(public readonly blocked: Array<{ matchId: string; kickoffUtc: string }>) {
    const list = blocked.map((b) => `${b.matchId} @ ${b.kickoffUtc}`).join(", ")
    super(`seal blocked: ${blocked.length} candidate(s) already started (${list})`)
    this.name = "SealBlockedError"
  }
}

/** Candidates whose kickoff is at or before the seal time (already started). */
export function findBlockedMatches(candidates: PredictionArtifact[], sealedAt: string): PredictionArtifact[] {
  const sealedAtMs = Date.parse(sealedAt)
  return candidates.filter((p) => Date.parse(p.kickoffUtc) <= sealedAtMs)
}

/* --------------------------- classification --------------------------- */

export interface CandidateClassification {
  /** Candidates whose kickoff is at or before the seal time (→ late backtests). */
  lateBacktests: PredictionArtifact[]
  /** Candidates still strictly in the future (→ the seal batch). */
  futureCandidates: PredictionArtifact[]
}

function byKickoffThenId(a: { kickoffUtc: string; id: string }, b: { kickoffUtc: string; id: string }): number {
  if (a.kickoffUtc !== b.kickoffUtc) return a.kickoffUtc < b.kickoffUtc ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Split candidates into those already started and those still in the future. */
export function classifyCandidates(candidates: PredictionArtifact[], sealedAt: string): CandidateClassification {
  const sealedAtMs = Date.parse(sealedAt)
  const lateBacktests: PredictionArtifact[] = []
  const futureCandidates: PredictionArtifact[] = []
  for (const c of candidates) {
    if (Date.parse(c.kickoffUtc) <= sealedAtMs) lateBacktests.push(c)
    else futureCandidates.push(c)
  }
  lateBacktests.sort(byKickoffThenId)
  futureCandidates.sort(byKickoffThenId)
  return { lateBacktests, futureCandidates }
}

/* --------------------------- sealing --------------------------- */

export function buildSealedPrediction(pred: PredictionArtifact, sealedAt: string): SealedPrediction {
  const originalPredictionHash = hashObject(pred)
  const snapshot: SealedPredictionSnapshot = { ...pred, predictionState: "sealed" }
  return {
    id: pred.id,
    slug: pred.slug,
    kickoffUtc: pred.kickoffUtc,
    predictionType: "candidate",
    predictionState: "sealed",
    sealedAt,
    publishedAt: null,
    eligibleForOfficialAccuracy: false,
    adjusted: false,
    revision: 1,
    originalPredictionHash,
    finalPredictionHash: hashObject(snapshot),
    originalPredictedResult: pred.predictedResult,
    prediction: snapshot,
  }
}

export interface SealInput {
  predictions: PredictionArtifact[]
  sealedAt: string
  competitionSlug: string
  season: string
}

/**
 * Build the season-wide sealed snapshot from the full 380 Phase VII predictions.
 * All-or-nothing: if any candidate has already started, throws `SealBlockedError`
 * (never a partial seal); if the candidate/backtest split is not exactly 340/40,
 * throws. Does not mutate the input predictions.
 */
export function buildSealedPredictions(input: SealInput): SealedPredictionsFile {
  const backtests = input.predictions.filter((p) => p.predictionType === "backtest")
  const candidates = input.predictions.filter((p) => p.predictionType === "candidate")

  if (backtests.length !== 40) throw new Error(`expected 40 backtest predictions, got ${backtests.length}`)
  if (candidates.length !== 340) throw new Error(`expected 340 candidate predictions, got ${candidates.length}`)

  for (const c of candidates) {
    if (c.predictionState !== "unlocked") {
      throw new Error(`candidate ${c.id} is not unlocked (state ${c.predictionState}); refuse to re-seal`)
    }
    if (c.eligibleForOfficialAccuracy !== false) {
      throw new Error(`candidate ${c.id} must not be eligible for official accuracy before publication`)
    }
  }

  const blocked = findBlockedMatches(candidates, input.sealedAt)
  if (blocked.length > 0) {
    throw new SealBlockedError(blocked.map((b) => ({ matchId: b.id, kickoffUtc: b.kickoffUtc })))
  }

  const sealed = candidates
    .map((c) => buildSealedPrediction(c, input.sealedAt))
    .sort((a, b) => (a.kickoffUtc !== b.kickoffUtc ? (a.kickoffUtc < b.kickoffUtc ? -1 : 1) : a.id < b.id ? -1 : 1))

  const batchHash = sha256Hex(...sealed.map((s) => s.finalPredictionHash))

  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    sealMode: "season_publication",
    sealedAt: input.sealedAt,
    batchHash,
    backtests: {
      excluded: true,
      count: backtests.length,
      note:
        "Backtest predictions are permanent historical reconstructions; they are never sealed and never eligible for official accuracy.",
    },
    counts: {
      totalPredictions: input.predictions.length,
      backtestCount: backtests.length,
      sealedCandidateCount: sealed.length,
      publishedPredictionCount: 0,
    },
    candidates: sealed,
  }
}

/* --------------------------- remaining-future seal --------------------------- */

export interface RemainingFutureSealedFile {
  schemaVersion: 1
  competitionSlug: string
  season: string
  sealMode: "remaining_future_season_publication"
  sealedAt: string
  batchHash: string
  backtests: { excluded: true; originalCount: number; lateCount: number; totalCount: number; note: string }
  counts: {
    totalPredictions: number
    originalBacktestCount: number
    lateBacktestCount: number
    totalBacktestCount: number
    sealedCandidateCount: number
    publishedPredictionCount: number
  }
  candidates: SealedPrediction[]
}

/**
 * Seal only the candidates that are still strictly in the future at `sealedAt`.
 * The already-started candidates are classified as late backtests (handled by the
 * caller via eligibility overrides), never silently dropped or back-dated. The
 * batch is all-or-nothing and the count is pinned: it refuses to auto-shrink the
 * batch if the future count is not exactly the expected number, and it refuses
 * (SealBlockedError) if any remaining candidate has already started. The Phase VII
 * input is never mutated.
 */
export function buildRemainingFutureSealedPredictions(input: SealInput): RemainingFutureSealedFile {
  const backtests = input.predictions.filter((p) => p.predictionType === "backtest")
  const candidates = input.predictions.filter((p) => p.predictionType === "candidate")

  if (backtests.length !== 40) throw new Error(`expected 40 backtest predictions, got ${backtests.length}`)
  if (candidates.length !== 340) throw new Error(`expected 340 candidate predictions, got ${candidates.length}`)

  const { lateBacktests, futureCandidates } = classifyCandidates(candidates, input.sealedAt)

  if (lateBacktests.length !== 10) {
    throw new Error(`expected exactly 10 late backtests, got ${lateBacktests.length} — refusing to auto-shrink the future batch`)
  }
  if (futureCandidates.length !== 330) {
    throw new Error(`expected exactly 330 remaining future candidates, got ${futureCandidates.length} — refusing to auto-shrink the future batch`)
  }

  for (const c of futureCandidates) {
    if (c.predictionState !== "unlocked") {
      throw new Error(`candidate ${c.id} is not unlocked (state ${c.predictionState}); refuse to re-seal`)
    }
    if (c.eligibleForOfficialAccuracy !== false) {
      throw new Error(`candidate ${c.id} must not be eligible for official accuracy before publication`)
    }
  }

  const sealed = futureCandidates
    .map((c) => buildSealedPrediction(c, input.sealedAt))
    .sort(byKickoffThenId)

  const batchHash = sha256Hex(...sealed.map((s) => s.finalPredictionHash))

  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    sealMode: "remaining_future_season_publication",
    sealedAt: input.sealedAt,
    batchHash,
    backtests: {
      excluded: true,
      originalCount: backtests.length,
      lateCount: lateBacktests.length,
      totalCount: backtests.length + lateBacktests.length,
      note:
        "Backtest predictions (40 original + 10 late) are permanent historical/post-event reconstructions; they are never sealed and never eligible for official accuracy.",
    },
    counts: {
      totalPredictions: input.predictions.length,
      originalBacktestCount: backtests.length,
      lateBacktestCount: lateBacktests.length,
      totalBacktestCount: backtests.length + lateBacktests.length,
      sealedCandidateCount: sealed.length,
      publishedPredictionCount: 0,
    },
    candidates: sealed,
  }
}

/* --------------------------- seal manifest --------------------------- */

export interface SealManifestInput {
  competitionSlug: string
  season: string
  sealMode: SealMode
  sealedAt: string
  sourceCommit: string
  sourcePredictionsHash: string
  eligibilityOverridesHash: string
  adjustmentLedgerHash: string
  sealedPredictionsHash: string
  effectiveCatalogHash: string
  totalPredictions: number
  originalBacktestCount: number
  lateBacktestCount: number
  sealedCandidateCount: number
  manualAdjustmentCount: number
}

export function buildSealManifest(input: SealManifestInput): SealManifest {
  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    sealMode: input.sealMode,
    sealedAt: input.sealedAt,
    sourceCommit: input.sourceCommit,
    sourcePredictionsHash: input.sourcePredictionsHash,
    eligibilityOverridesHash: input.eligibilityOverridesHash,
    adjustmentLedgerHash: input.adjustmentLedgerHash,
    sealedPredictionsHash: input.sealedPredictionsHash,
    effectiveCatalogHash: input.effectiveCatalogHash,
    totalPredictions: input.totalPredictions,
    originalBacktestCount: input.originalBacktestCount,
    lateBacktestCount: input.lateBacktestCount,
    totalBacktestCount: input.originalBacktestCount + input.lateBacktestCount,
    sealedCandidateCount: input.sealedCandidateCount,
    manualAdjustmentCount: input.manualAdjustmentCount,
    publishedPredictionCount: 0,
    officialPredictionCount: 0,
    officialAccuracy: null,
  }
}
