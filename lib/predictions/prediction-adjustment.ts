/**
 * Manual adjustment mechanism for Phase VIII. Adjustments are only allowed
 * BEFORE the season seal; after sealing they are rejected outright. Every
 * adjustment is an append-only audit event that preserves the original model
 * prediction, the before/after snapshots, the changed fields, the editor id,
 * the reason, a real UTC timestamp, a per-match revision, and a hash chain.
 */

import { argmaxOneX2 } from "../model/poisson"
import type { PredictionReason, PredictionArtifact } from "../model/prediction-artifact"
import type { ConfidenceLevel, OneX2Probabilities, Result } from "../model/types"
import { hashObject, stableStringify } from "./prediction-lock"

/* --------------------------- proposal --------------------------- */

export interface AdjustmentProposal {
  editorId: string
  reason: string
  probabilities?: OneX2Probabilities
  predictedResult?: Result
  predictedScoreline?: { home: number; away: number }
  confidence?: { score: number; level: ConfidenceLevel }
  reasons?: PredictionReason[]
}

/* --------------------------- ledger --------------------------- */

export interface AdjustmentEvent {
  editorId: string
  reason: string
  matchId: string
  revision: number
  adjustedAt: string
  changedFields: string[]
  before: PredictionArtifact
  after: PredictionArtifact
  previousRevisionHash: string | null
  adjustmentHash: string
}

export interface AdjustmentLedger {
  schemaVersion: 1
  competitionSlug: string
  season: string
  events: AdjustmentEvent[]
  manualAdjustmentCount: number
}

export function emptyAdjustmentLedger(competitionSlug: string, season: string): AdjustmentLedger {
  return { schemaVersion: 1, competitionSlug, season, events: [], manualAdjustmentCount: 0 }
}

/* --------------------------- guard --------------------------- */

export class AdjustmentAfterSealError extends Error {
  constructor() {
    super("adjustments are forbidden after the season seal")
    this.name = "AdjustmentAfterSealError"
  }
}

/** Refuse any adjustment once the season has been sealed. */
export function guardAgainstPostSealAdjustment(sealed: boolean): void {
  if (sealed) throw new AdjustmentAfterSealError()
}

/**
 * Only unlocked candidates that are not permanently ineligible are adjustable.
 * Original backtests, late backtests, and already-sealed candidates are rejected.
 */
export function assertAdjustableTarget(pred: PredictionArtifact, permanentlyIneligible = false): void {
  if (pred.predictionType !== "candidate" || pred.predictionState !== "unlocked") {
    throw new Error(`only unlocked candidates are adjustable (got ${pred.predictionType}/${pred.predictionState})`)
  }
  if (permanentlyIneligible) {
    throw new Error("permanently ineligible predictions are not adjustable")
  }
}

/* --------------------------- validation --------------------------- */

const MEANINGLESS_REASONS = new Set([
  "优化",
  "修改",
  "调整",
  "改进",
  "improve",
  "improvement",
  "fix",
  "fixing",
  "tweak",
  "change",
  "update",
  "adjust",
  "adjustment",
  "better",
])

/** Minimum length for a meaningful adjustment reason. */
export const MIN_REASON_LENGTH = 20

export function isMeaninglessReason(reason: string): boolean {
  const norm = reason.trim().toLowerCase().replace(/\s+/g, " ")
  if (MEANINGLESS_REASONS.has(norm)) return true
  const meaningful = norm.replace(/[^a-z0-9一-鿿]/g, "")
  return meaningful.length < 4
}

const CONFIDENCE_LEVELS: ReadonlySet<ConfidenceLevel> = new Set(["low", "medium", "high"])

/** Validate the proposal itself (editor, reason). Returns an error or null. */
export function validateProposal(proposal: AdjustmentProposal): string | null {
  if (typeof proposal.editorId !== "string" || proposal.editorId.trim() === "") {
    return "editorId must be a non-empty string"
  }
  if (typeof proposal.reason !== "string" || proposal.reason.trim().length < MIN_REASON_LENGTH) {
    return `reason must be at least ${MIN_REASON_LENGTH} characters`
  }
  if (isMeaninglessReason(proposal.reason)) {
    return "reason must be a specific, substantive explanation (not a generic placeholder)"
  }
  return null
}

/**
 * Validate a fully-adjusted prediction artifact's adjustable fields. Returns an
 * error string, or null when legal. Checks legality + sum-to-1 of probabilities,
 * argmax consistency, integer scoreline, confidence schema, and reason count.
 */
export function validateAdjustedPrediction(pred: PredictionArtifact): string | null {
  const { home, draw, away } = pred.probabilities
  if (!(home >= 0 && draw >= 0 && away >= 0)) return "probabilities must be non-negative"
  if (Math.abs(home + draw + away - 1) > 1e-9) return "probabilities must sum to 1"
  if (pred.predictedResult !== argmaxOneX2(pred.probabilities)) {
    return `predictedResult ${pred.predictedResult} does not equal argmax ${argmaxOneX2(pred.probabilities)}`
  }
  const { home: sh, away: sa } = pred.predictedScoreline
  if (!(Number.isInteger(sh) && Number.isInteger(sa) && sh >= 0 && sa >= 0)) {
    return "predictedScoreline must be non-negative integers"
  }
  if (!CONFIDENCE_LEVELS.has(pred.confidence.level)) return "confidence.level must be low|medium|high"
  if (!(pred.confidence.score >= 0 && pred.confidence.score <= 1)) return "confidence.score must be in [0, 1]"
  if (!(pred.reasons.length >= 3 && pred.reasons.length <= 5)) return "reasons must be 3..5"
  return null
}

/* --------------------------- applying --------------------------- */

const ADJUSTABLE_FIELDS: Array<"probabilities" | "predictedResult" | "predictedScoreline" | "confidence" | "reasons"> = [
  "probabilities",
  "predictedResult",
  "predictedScoreline",
  "confidence",
  "reasons",
]

/** Build the adjusted artifact, deriving `predictedResult` from the probabilities. */
function buildAdjusted(current: PredictionArtifact, proposal: AdjustmentProposal): PredictionArtifact {
  const probabilities = proposal.probabilities ?? current.probabilities
  const predictedResult = proposal.predictedResult ?? argmaxOneX2(probabilities)
  return {
    ...current,
    probabilities,
    predictedResult,
    predictedScoreline: proposal.predictedScoreline ?? current.predictedScoreline,
    confidence: proposal.confidence ?? current.confidence,
    reasons: proposal.reasons ?? current.reasons,
  }
}

function computeChangedFields(before: PredictionArtifact, after: PredictionArtifact): string[] {
  return ADJUSTABLE_FIELDS.filter((f) => stableStringify(before[f]) !== stableStringify(after[f]))
}

/**
 * Append one adjustment event to the ledger (never overwrites prior events).
 * Validates the proposal and the resulting artifact; throws on any violation.
 * The original prediction is preserved untouched in `before`, and `after` is a
 * new object. `adjustedAt` is caller-supplied real UTC (no clock here).
 */
export function applyAdjustment(
  ledger: AdjustmentLedger,
  current: PredictionArtifact,
  proposal: AdjustmentProposal,
  adjustedAt: string,
): AdjustmentLedger {
  const proposalError = validateProposal(proposal)
  if (proposalError) throw new Error(`invalid adjustment: ${proposalError}`)

  const after = buildAdjusted(current, proposal)
  const artifactError = validateAdjustedPrediction(after)
  if (artifactError) throw new Error(`invalid adjusted prediction: ${artifactError}`)

  const priorForMatch = ledger.events.filter((e) => e.matchId === current.id)
  const revision = priorForMatch.length + 1
  const previousRevisionHash = priorForMatch.length === 0 ? null : priorForMatch[priorForMatch.length - 1].adjustmentHash
  const changedFields = computeChangedFields(current, after)

  const base = {
    editorId: proposal.editorId.trim(),
    reason: proposal.reason.trim(),
    matchId: current.id,
    revision,
    adjustedAt,
    changedFields,
    before: current,
    after,
    previousRevisionHash,
  }
  const event: AdjustmentEvent = { ...base, adjustmentHash: hashObject(base) }

  const events = [...ledger.events, event]
  return { ...ledger, events, manualAdjustmentCount: events.length }
}
