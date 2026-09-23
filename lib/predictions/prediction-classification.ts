/**
 * Candidate eligibility classification (Phase VIII, revised).
 *
 * When the season seal runs after some candidates have already kicked off, those
 * candidates can never be a verifiable pre-match prediction. Instead of deleting
 * them, silently folding them into the original 40 backtests, or back-dating a
 * `sealedAt`, this module derives a "late backtest" status for them and emits:
 *
 *   - `eligibility-overrides.json` — the permanent ineligibility records;
 *   - `effective-prediction-catalog.json` — a 380-entry index over
 *     40 original backtests + 10 late backtests + 330 sealed candidates.
 *
 * The Phase VII `predictions.json` is never modified: the derived status is an
 * overlay that references the original artifacts by id/hash. Everything here is
 * pure and deterministic — no I/O, no clock, no model math.
 */

import type { PredictionArtifact } from "../model/prediction-artifact"
import { hashObject, type SealedPrediction } from "./prediction-lock"

/* --------------------------- classification --------------------------- */

export type EffectivePredictionState = "historical_reconstruction" | "post_event_reconstruction" | "sealed"
export type EligibilityStatus = "permanently_ineligible" | "ineligible_pending_publication"

/** A permanent-ineligibility override for one candidate that already kicked off. */
export interface LateBacktestOverride {
  matchId: string
  originalPredictionType: "candidate"
  effectivePredictionType: "backtest"
  effectivePredictionState: "post_event_reconstruction"
  kickoffUtc: string
  generatedAt: string
  detectedAt: string
  startedBeforeGeneration: boolean
  startedBeforeSeal: boolean
  eligibleForOfficialAccuracy: false
  permanentlyIneligible: true
  reason: "generated_or_sealed_after_kickoff"
  originalPredictionHash: string
}

export interface EligibilityOverridesFile {
  schemaVersion: 1
  competitionSlug: string
  season: string
  detectedAt: string
  lateBacktestCount: number
  overrides: LateBacktestOverride[]
}

export interface EffectiveCatalogEntry {
  matchId: string
  originalPredictionType: "backtest" | "candidate"
  effectivePredictionType: "backtest" | "candidate"
  effectivePredictionState: EffectivePredictionState
  eligibilityStatus: EligibilityStatus
  originalPredictionHash: string
  finalPredictionHash: string | null
  sealedAt: string | null
  publishedAt: string | null
  eligibleForOfficialAccuracy: false
  permanentlyIneligible: boolean
  ineligibilityReason: string | null
}

export interface EffectiveCatalogFile {
  schemaVersion: 1
  competitionSlug: string
  season: string
  totalPredictions: number
  originalBacktestCount: number
  lateBacktestCount: number
  totalBacktestCount: number
  sealedCandidateCount: number
  publishedPredictionCount: number
  entries: EffectiveCatalogEntry[]
}

/* --------------------------- overrides --------------------------- */

function byKickoff<T extends { kickoffUtc: string; id?: string }>(a: T, b: T): number {
  if (a.kickoffUtc !== b.kickoffUtc) return a.kickoffUtc < b.kickoffUtc ? -1 : 1
  if (a.id && b.id && a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** Build one permanent-ineligibility override for a candidate that already kicked off. */
export function buildLateBacktestOverride(pred: PredictionArtifact, detectedAt: string): LateBacktestOverride {
  const kickoffMs = Date.parse(pred.kickoffUtc)
  return {
    matchId: pred.id,
    originalPredictionType: "candidate",
    effectivePredictionType: "backtest",
    effectivePredictionState: "post_event_reconstruction",
    kickoffUtc: pred.kickoffUtc,
    generatedAt: pred.generatedAt,
    detectedAt,
    startedBeforeGeneration: kickoffMs < Date.parse(pred.generatedAt),
    startedBeforeSeal: kickoffMs <= Date.parse(detectedAt),
    eligibleForOfficialAccuracy: false,
    permanentlyIneligible: true,
    reason: "generated_or_sealed_after_kickoff",
    originalPredictionHash: hashObject(pred),
  }
}

export function buildEligibilityOverridesFile(input: {
  competitionSlug: string
  season: string
  detectedAt: string
  lateBacktests: PredictionArtifact[]
}): EligibilityOverridesFile {
  const overrides = [...input.lateBacktests]
    .sort(byKickoff)
    .map((p) => buildLateBacktestOverride(p, input.detectedAt))
  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    detectedAt: input.detectedAt,
    lateBacktestCount: overrides.length,
    overrides,
  }
}

/* --------------------------- effective catalog --------------------------- */

export interface EffectiveCatalogInput {
  competitionSlug: string
  season: string
  originalBacktests: PredictionArtifact[]
  overrides: LateBacktestOverride[]
  sealedCandidates: SealedPrediction[]
}

/**
 * Build the 380-entry effective catalog. It references only the already-existing
 * prediction core fields (probabilities/scoreline/result/confidence/reasons are
 * carried inside the sealed `prediction` snapshot, never recomputed here). Order
 * is stable: original backtests, then late backtests, then sealed candidates.
 */
export function buildEffectiveCatalog(input: EffectiveCatalogInput): EffectiveCatalogFile {
  const entries: EffectiveCatalogEntry[] = []

  for (const p of [...input.originalBacktests].sort(byKickoff)) {
    const h = hashObject(p)
    entries.push({
      matchId: p.id,
      originalPredictionType: "backtest",
      effectivePredictionType: "backtest",
      effectivePredictionState: "historical_reconstruction",
      eligibilityStatus: "permanently_ineligible",
      originalPredictionHash: h,
      finalPredictionHash: h,
      sealedAt: null,
      publishedAt: null,
      eligibleForOfficialAccuracy: false,
      permanentlyIneligible: true,
      ineligibilityReason: "backtest_historical_reconstruction",
    })
  }

  for (const o of [...input.overrides].sort((a, b) => (a.kickoffUtc < b.kickoffUtc ? -1 : 1))) {
    entries.push({
      matchId: o.matchId,
      originalPredictionType: "candidate",
      effectivePredictionType: "backtest",
      effectivePredictionState: "post_event_reconstruction",
      eligibilityStatus: "permanently_ineligible",
      originalPredictionHash: o.originalPredictionHash,
      finalPredictionHash: o.originalPredictionHash,
      sealedAt: null,
      publishedAt: null,
      eligibleForOfficialAccuracy: false,
      permanentlyIneligible: true,
      ineligibilityReason: o.reason,
    })
  }

  for (const s of input.sealedCandidates) {
    entries.push({
      matchId: s.id,
      originalPredictionType: "candidate",
      effectivePredictionType: "candidate",
      effectivePredictionState: "sealed",
      eligibilityStatus: "ineligible_pending_publication",
      originalPredictionHash: s.originalPredictionHash,
      finalPredictionHash: s.finalPredictionHash,
      sealedAt: s.sealedAt,
      publishedAt: null,
      eligibleForOfficialAccuracy: false,
      permanentlyIneligible: false,
      ineligibilityReason: "not_yet_published",
    })
  }

  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    totalPredictions: entries.length,
    originalBacktestCount: input.originalBacktests.length,
    lateBacktestCount: input.overrides.length,
    totalBacktestCount: input.originalBacktests.length + input.overrides.length,
    sealedCandidateCount: input.sealedCandidates.length,
    publishedPredictionCount: 0,
    entries,
  }
}

/** A permanently-ineligible entry can never be reclassified back to a candidate. */
export function isReclassifiableToCandidate(entry: EffectiveCatalogEntry): boolean {
  return !entry.permanentlyIneligible && entry.effectivePredictionType === "candidate"
}
