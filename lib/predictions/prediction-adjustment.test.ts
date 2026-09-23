/**
 * Tests for the manual adjustment mechanism. Verifies adjustments are only
 * allowed before sealing, preserve the original prediction, keep an append-only
 * hash-chained revision history, and reject illegal probabilities, argmax
 * mismatches, and meaningless reasons.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { PredictionArtifact, PredictionReason } from "../model/prediction-artifact"
import { hashObject } from "./prediction-lock"
import {
  AdjustmentAfterSealError,
  applyAdjustment,
  assertAdjustableTarget,
  emptyAdjustmentLedger,
  guardAgainstPostSealAdjustment,
  isMeaninglessReason,
  validateAdjustedPrediction,
  validateProposal,
} from "./prediction-adjustment"

const ADJUSTED_AT = "2026-07-02T09:30:00Z"

function reason(code: string): PredictionReason {
  return { code, label: code, text: `${code} explanation`, value: 1, comparisonValue: 0, direction: "none", source: "v1" }
}

function makeCandidate(): PredictionArtifact {
  return {
    id: "pl-2026-27-arsenal-fc-vs-chelsea-fc-1001",
    slug: "arsenal-fc-vs-chelsea-fc-1001",
    competitionSlug: "premier-league",
    season: "2026-27",
    matchweek: 1,
    kickoffUtc: "2026-08-15T15:00:00Z",
    homeTeam: { slug: "arsenal-fc", name: "Arsenal", shortName: "ARS" },
    awayTeam: { slug: "chelsea-fc", name: "Chelsea", shortName: "CHE" },
    predictionType: "candidate",
    predictionState: "unlocked",
    actualScore: null,
    predictedScoreline: { home: 2, away: 1 },
    modelVersion: "1.0.0",
    configHash: "28b50575b3ceea4dcad6d6d3e581f2895d825c84b82745def1214f9678679680",
    generatedAt: "2026-09-21T15:21:05Z",
    dataCutoff: "2026-09-18T00:20:33Z",
    eligibleForOfficialAccuracy: false,
    probabilities: { home: 0.55, draw: 0.25, away: 0.2 },
    predictedResult: "H",
    topScorelines: [{ home: 2, away: 1, probability: 0.1 }],
    confidence: { score: 0.5, level: "medium" },
    lambda: { home: 1.5, away: 1.2 },
    elo: { home: 1600, away: 1550 },
    reasons: [reason("EXPECTED_GOALS"), reason("HOME_ADVANTAGE"), reason("ELO_ADVANTAGE_HOME")],
  }
}

function validProposal() {
  return {
    editorId: "analyst-1",
    reason: "Home attack data over the last five matches supports a stronger home win probability.",
    probabilities: { home: 0.6, draw: 0.22, away: 0.18 },
  }
}

// #11 adjustments only before seal
test("guard passes before seal and the policy forbids post-seal adjustment", () => {
  assert.doesNotThrow(() => guardAgainstPostSealAdjustment(false))
})

// #12 post-seal adjustment always fails
test("guard throws AdjustmentAfterSealError after seal", () => {
  assert.throws(() => guardAgainstPostSealAdjustment(true), AdjustmentAfterSealError)
})

// #13 adjustment preserves the full original prediction
test("applyAdjustment preserves the original prediction untouched in before", () => {
  const current = makeCandidate()
  const original = JSON.parse(JSON.stringify(current))
  const ledger = applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), current, validProposal(), ADJUSTED_AT)
  assert.deepEqual(ledger.events[0].before, original)
  assert.deepEqual(current, original) // input object untouched
  assert.notEqual(ledger.events[0].after, ledger.events[0].before) // after is a new object
})

// #14 revision + hash chain correct
test("revisions increment per match and hash-chain to the previous adjustment", () => {
  const current = makeCandidate()
  let ledger = emptyAdjustmentLedger("premier-league", "2026-27")
  ledger = applyAdjustment(ledger, current, validProposal(), "2026-07-02T09:30:00Z")
  const first = ledger.events[0]
  assert.equal(first.revision, 1)
  assert.equal(first.previousRevisionHash, null)
  assert.equal(first.adjustmentHash, hashObject({
    editorId: first.editorId,
    reason: first.reason,
    matchId: first.matchId,
    revision: 1,
    adjustedAt: "2026-07-02T09:30:00Z",
    changedFields: first.changedFields,
    before: first.before,
    after: first.after,
    previousRevisionHash: null,
  }))

  const second = applyAdjustment(ledger, first.after, validProposal(), "2026-07-02T09:35:00Z")
  const ev2 = second.events[1]
  assert.equal(ev2.revision, 2)
  assert.equal(ev2.previousRevisionHash, first.adjustmentHash)
  assert.equal(second.manualAdjustmentCount, 2)
})

// #15 illegal probability adjustment rejected
test("rejects probabilities that do not sum to 1", () => {
  assert.throws(
    () => applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), makeCandidate(), { ...validProposal(), probabilities: { home: 0.6, draw: 0.3, away: 0.3 } }, ADJUSTED_AT),
    /sum to 1/,
  )
  assert.throws(
    () => applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), makeCandidate(), { ...validProposal(), probabilities: { home: -0.1, draw: 0.5, away: 0.6 } }, ADJUSTED_AT),
    /non-negative/,
  )
})

// #16 predictedResult != argmax rejected
test("rejects a predictedResult inconsistent with the probability argmax", () => {
  const broken = makeCandidate()
  broken.probabilities = { home: 0.6, draw: 0.22, away: 0.18 }
  broken.predictedResult = "A"
  assert.match(validateAdjustedPrediction(broken)!, /does not equal argmax/)
  assert.throws(
    () => applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), makeCandidate(), { ...validProposal(), probabilities: { home: 0.6, draw: 0.22, away: 0.18 }, predictedResult: "A" }, ADJUSTED_AT),
    /does not equal argmax/,
  )
})

// #17 meaningless adjustment reason rejected
test("rejects meaningless or too-short reasons", () => {
  assert.equal(isMeaninglessReason("优化"), true)
  assert.equal(isMeaninglessReason("修改"), true)
  assert.equal(isMeaninglessReason("adjust"), true)
  assert.equal(validateProposal({ editorId: "x", reason: "优化" }), "reason must be at least 20 characters")
  assert.throws(
    () => applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), makeCandidate(), { editorId: "analyst", reason: "优化" }, ADJUSTED_AT),
    /at least 20 characters/,
  )
})

test("rejects an empty editorId", () => {
  assert.throws(
    () => applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), makeCandidate(), { ...validProposal(), editorId: "  " }, ADJUSTED_AT),
    /editorId/,
  )
})

// #18 adjustment events are append-only and never overwritten
test("events are append-only; prior ledger is never mutated", () => {
  const current = makeCandidate()
  const ledger = applyAdjustment(emptyAdjustmentLedger("premier-league", "2026-27"), current, validProposal(), ADJUSTED_AT)
  const snapshot = JSON.parse(JSON.stringify(ledger.events))
  const updated = applyAdjustment(ledger, ledger.events[0].after, validProposal(), "2026-07-02T09:40:00Z")
  assert.equal(updated.events.length, 2)
  assert.deepEqual(ledger.events, snapshot) // original ledger events untouched
  assert.equal(updated.manualAdjustmentCount, updated.events.length)
})

test("valid proposal passes validation", () => {
  assert.equal(validateProposal(validProposal()), null)
  const after = { ...makeCandidate(), probabilities: { home: 0.6, draw: 0.22, away: 0.18 }, predictedResult: "H" as const }
  assert.equal(validateAdjustedPrediction(after), null)
})

// #13 original backtests are not adjustable
test("original backtests are not adjustable", () => {
  const bt = makeCandidate()
  bt.predictionType = "backtest"
  bt.predictionState = "historical_reconstruction"
  assert.throws(() => assertAdjustableTarget(bt), /only unlocked candidates/)
})

// #14 late backtests (permanently ineligible) are not adjustable
test("permanently ineligible late backtests are not adjustable", () => {
  assert.throws(() => assertAdjustableTarget(makeCandidate(), true), /permanently ineligible/)
})

// #15 sealed candidates are not adjustable after the season seal
test("sealed candidates are not adjustable after the season seal", () => {
  assert.throws(() => guardAgainstPostSealAdjustment(true), AdjustmentAfterSealError)
})
