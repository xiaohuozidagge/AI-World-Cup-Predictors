/**
 * Tests for official-accuracy eligibility. Verifies only sealed-before-kickoff
 * AND published-before-kickoff, non-backtest, non-cancelled predictions with a
 * verified seal hash can count toward official accuracy, that accuracy reads
 * only the sealed snapshot, and that the original model can be scored separately
 * from any manually adjusted version.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeOfficialAccuracy,
  evaluateSeparately,
  isEligibleForOfficialAccuracy,
  type EligibilityContext,
} from "./official-eligibility"

function ctx(overrides: Partial<EligibilityContext>): EligibilityContext {
  return {
    predictionType: "candidate",
    predictionState: "published",
    sealedAt: "2026-07-01T12:00:00Z",
    publishedAt: "2026-07-02T12:00:00Z",
    kickoffUtc: "2026-08-15T15:00:00Z",
    cancelled: false,
    sealHashVerified: true,
    ...overrides,
  }
}

// #22 sealed before kickoff and published before kickoff is eligible
test("sealed and published before kickoff is eligible", () => {
  assert.equal(isEligibleForOfficialAccuracy(ctx({})), true)
})

// #20 unpublished predictions never count
test("unpublished (sealed or unlocked) predictions are not eligible", () => {
  assert.equal(isEligibleForOfficialAccuracy(ctx({ predictionState: "sealed", publishedAt: null })), false)
  assert.equal(isEligibleForOfficialAccuracy(ctx({ predictionState: "unlocked", sealedAt: null, publishedAt: null })), false)
})

// #21 published after kickoff never counts
test("published after kickoff is not eligible", () => {
  assert.equal(
    isEligibleForOfficialAccuracy(ctx({ publishedAt: "2026-08-16T00:00:00Z", kickoffUtc: "2026-08-15T15:00:00Z" })),
    false,
  )
})

test("sealed after kickoff is not eligible", () => {
  assert.equal(
    isEligibleForOfficialAccuracy(ctx({ sealedAt: "2026-08-16T00:00:00Z", kickoffUtc: "2026-08-15T15:00:00Z" })),
    false,
  )
})

// #23 backtest never eligible
test("backtest is never eligible", () => {
  assert.equal(isEligibleForOfficialAccuracy(ctx({ predictionType: "backtest", predictionState: "historical_reconstruction", sealedAt: null, publishedAt: null })), false)
})

// #24 cancelled/voided never eligible
test("cancelled or voided match is never eligible", () => {
  assert.equal(isEligibleForOfficialAccuracy(ctx({ cancelled: true })), false)
})

test("unverified seal hash is never eligible", () => {
  assert.equal(isEligibleForOfficialAccuracy(ctx({ sealHashVerified: false })), false)
})

// #25 official accuracy reads only the sealed snapshot (only eligible matches)
test("official accuracy counts only eligible sealed-snapshot matches", () => {
  const snapshot = [
    { id: "m1", predictionType: "candidate" as const, predictionState: "published" as const, predictedResult: "H" as const, eligibleForOfficialAccuracy: true },
    { id: "m2", predictionType: "candidate" as const, predictionState: "published" as const, predictedResult: "A" as const, eligibleForOfficialAccuracy: false },
    { id: "m3", predictionType: "candidate" as const, predictionState: "sealed" as const, predictedResult: "H" as const, eligibleForOfficialAccuracy: false },
  ]
  const results = new Map<string, "H" | "D" | "A">([
    ["m1", "H"],
    ["m2", "A"],
    ["m3", "H"],
  ])
  const acc = computeOfficialAccuracy(snapshot, results)
  assert.equal(acc.count, 1)
  assert.equal(acc.correct, 1)
  assert.equal(acc.accuracy, 1)
})

test("official accuracy is null when nothing is eligible", () => {
  const snapshot = [
    { id: "m1", predictionType: "candidate" as const, predictionState: "sealed" as const, predictedResult: "H" as const, eligibleForOfficialAccuracy: false },
  ]
  const acc = computeOfficialAccuracy(snapshot, new Map([["m1", "H" as const]]))
  assert.equal(acc.count, 0)
  assert.equal(acc.accuracy, null)
})

// #26 original model and manual version evaluated separately
test("original model and manual versions are scored separately", () => {
  const matches = [
    { id: "m1", adjusted: true, officialPredictedResult: "A" as const, originalModelPredictedResult: "H" as const },
    { id: "m2", adjusted: false, officialPredictedResult: "H" as const, originalModelPredictedResult: "H" as const },
  ]
  const results = new Map<string, "H" | "D" | "A">([
    ["m1", "A"], // adjusted version correct, original wrong
    ["m2", "H"], // both correct
  ])
  const evaln = evaluateSeparately(matches, results)
  assert.equal(evaln.officialLockedAccuracy, 1) // A,H both correct
  assert.equal(evaln.originalModelAccuracy, 0.5) // H correct, H wrong
  assert.equal(evaln.manuallyAdjustedCount, 1)
})

// #3 late backtest (post_event_reconstruction) is permanently ineligible
test("late backtest (post_event_reconstruction) is never eligible", () => {
  assert.equal(
    isEligibleForOfficialAccuracy(ctx({ predictionType: "backtest", predictionState: "post_event_reconstruction", sealedAt: null, publishedAt: null })),
    false,
  )
  assert.equal(
    isEligibleForOfficialAccuracy(ctx({ predictionState: "post_event_reconstruction", permanentlyIneligible: true })),
    false,
  )
})

// #4 later results/publication can never restore eligibility
test("permanentlyIneligible cannot be restored by later publication or results", () => {
  // Even a late backtest that is somehow "published" before kickoff stays ineligible.
  assert.equal(
    isEligibleForOfficialAccuracy(ctx({ permanentlyIneligible: true, predictionState: "published" })),
    false,
  )
})

// #19 a sealed candidate published after its kickoff is not eligible
test("sealed candidate published after kickoff is not eligible", () => {
  assert.equal(
    isEligibleForOfficialAccuracy(ctx({ predictionState: "published", publishedAt: "2026-09-26T00:00:00Z", kickoffUtc: "2026-09-25T15:00:00Z" })),
    false,
  )
})
