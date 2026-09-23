/**
 * Tests for the season-wide sealing layer. Verifies only valid Phase VII output
 * is accepted, the input is never mutated, exactly 340 candidates are sealed
 * (never the 40 backtests), sealing is all-or-nothing, the batch shares one
 * `sealedAt`, and every hash is correct and deterministic.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { sha256Hex, type PredictionArtifact, type PredictionReason } from "../model/prediction-artifact"
import {
  buildLockPolicy,
  buildRemainingFutureSealedPredictions,
  buildSealManifest,
  buildSealedPredictions,
  classifyCandidates,
  findBlockedMatches,
  hashObject,
  SealBlockedError,
  stableStringify,
} from "./prediction-lock"

const SEALED_AT = "2026-07-01T12:00:00Z"

function reason(code: string): PredictionReason {
  return { code, label: code, text: `${code} explanation`, value: 1, comparisonValue: 0, direction: "none", source: "v1" }
}

function makeCandidate(id: string, kickoffUtc: string): PredictionArtifact {
  return {
    id,
    slug: id,
    competitionSlug: "premier-league",
    season: "2026-27",
    matchweek: 1,
    kickoffUtc,
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

function makeBacktest(id: string, kickoffUtc: string): PredictionArtifact {
  const p = makeCandidate(id, kickoffUtc)
  p.predictionType = "backtest"
  p.predictionState = "historical_reconstruction"
  p.actualScore = { home: 1, away: 0 }
  return p
}

function fullInput(candidates: PredictionArtifact[], backtests: PredictionArtifact[]) {
  return { predictions: [...backtests, ...candidates], sealedAt: SEALED_AT, competitionSlug: "premier-league", season: "2026-27" }
}

function fortyBacktests(): PredictionArtifact[] {
  return Array.from({ length: 40 }, (_, i) => makeBacktest(`bt-${i}`, `2026-05-${String((i % 28) + 1).padStart(2, "0")}T15:00:00Z`))
}

function threeHundredFortyCandidates(): PredictionArtifact[] {
  return Array.from({ length: 340 }, (_, i) => makeCandidate(`cand-${i}`, `2026-08-${String((i % 28) + 1).padStart(2, "0")}T15:00:00Z`))
}

test("stableStringify sorts keys and is insertion-order independent", () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } })
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 })
  assert.equal(a, b)
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}')
})

test("hashObject is deterministic and covers the whole structure", () => {
  const v = { a: 1, b: [2, 3], c: { d: "x" } }
  assert.equal(hashObject(v), hashObject({ b: [2, 3], c: { d: "x" }, a: 1 }))
  assert.equal(hashObject(v), sha256Hex(stableStringify(v)))
})

// #1 only accepts valid Phase VII output (exact 40 backtests + 340 candidates)
test("rejects when the backtest/candidate split is not exactly 40/340", () => {
  assert.throws(() => buildSealedPredictions(fullInput([makeCandidate("a", "2026-08-01T15:00:00Z")], [])), /expected 40 backtest/)
  assert.throws(
    () => buildSealedPredictions(fullInput(threeHundredFortyCandidates().slice(0, 339), fortyBacktests())),
    /expected 340 candidate/,
  )
})

test("rejects a candidate that is not unlocked", () => {
  const candidates = threeHundredFortyCandidates()
  candidates[0] = { ...candidates[0], predictionState: "historical_reconstruction" }
  assert.throws(() => buildSealedPredictions(fullInput(candidates, fortyBacktests())), /not unlocked/)
})

// #2 input is never mutated
test("does not mutate the input predictions", () => {
  const candidates = threeHundredFortyCandidates()
  const backtests = fortyBacktests()
  const before = JSON.parse(JSON.stringify(candidates))
  buildSealedPredictions(fullInput(candidates, backtests))
  assert.deepEqual(candidates, before)
})

// #3 340 candidates all sealed; #4 40 backtests never sealed
test("seals exactly 340 candidates and excludes all 40 backtests", () => {
  const sealed = buildSealedPredictions(fullInput(threeHundredFortyCandidates(), fortyBacktests()))
  assert.equal(sealed.counts.sealedCandidateCount, 340)
  assert.equal(sealed.counts.backtestCount, 40)
  assert.equal(sealed.counts.totalPredictions, 380)
  assert.equal(sealed.candidates.length, 340)
  assert.equal(sealed.backtests.excluded, true)
  for (const c of sealed.candidates) {
    assert.equal(c.predictionType, "candidate")
    assert.equal(c.predictionState, "sealed")
  }
})

// #5 all candidates sealed before kickoff
test("all candidates are sealed before their kickoff", () => {
  const sealed = buildSealedPredictions(fullInput(threeHundredFortyCandidates(), fortyBacktests()))
  for (const c of sealed.candidates) {
    assert.ok(Date.parse(c.sealedAt) < Date.parse(c.kickoffUtc), `${c.id} sealed after kickoff`)
  }
  assert.deepEqual(findBlockedMatches(threeHundredFortyCandidates(), SEALED_AT), [])
})

// #6 started match blocks the whole batch; #7 no partial success
test("a started candidate throws SealBlockedError with ids/timestamps/count", () => {
  const candidates = threeHundredFortyCandidates()
  candidates[7] = makeCandidate("started-match", "2026-06-01T15:00:00Z") // before SEALED_AT
  try {
    buildSealedPredictions(fullInput(candidates, fortyBacktests()))
    assert.fail("expected SealBlockedError")
  } catch (err) {
    assert.ok(err instanceof SealBlockedError)
    const e = err as SealBlockedError
    assert.equal(e.blocked.length, 1)
    assert.equal(e.blocked[0].matchId, "started-match")
    assert.equal(e.blocked[0].kickoffUtc, "2026-06-01T15:00:00Z")
    assert.match(e.message, /1 candidate/)
  }
})

// #8 one unified sealedAt
test("all sealed candidates share the same sealedAt", () => {
  const sealed = buildSealedPredictions(fullInput(threeHundredFortyCandidates(), fortyBacktests()))
  assert.equal(new Set(sealed.candidates.map((c) => c.sealedAt)).size, 1)
  assert.equal(sealed.candidates[0].sealedAt, SEALED_AT)
})

// #9 original prediction hash correct; #10 sealed snapshot + batch hash correct
test("original/final/batch hashes are computed correctly", () => {
  const candidates = threeHundredFortyCandidates()
  const sealed = buildSealedPredictions(fullInput(candidates, fortyBacktests()))
  // candidates are rebuilt with fresh ids; align by id
  const byId = new Map(candidates.map((c) => [c.id, c]))
  for (const s of sealed.candidates) {
    const original = byId.get(s.id)!
    assert.equal(s.originalPredictionHash, hashObject(original))
    assert.equal(s.finalPredictionHash, hashObject({ ...original, predictionState: "sealed" }))
  }
  const expectedBatch = sha256Hex(...sealed.candidates.map((s) => s.finalPredictionHash))
  assert.equal(sealed.batchHash, expectedBatch)
})

// #19 determinism
test("same input and sealedAt produce byte-identical sealed output", () => {
  const a = buildSealedPredictions(fullInput(threeHundredFortyCandidates(), fortyBacktests()))
  const b = buildSealedPredictions(fullInput(threeHundredFortyCandidates(), fortyBacktests()))
  assert.equal(hashObject(a), hashObject(b))
})

// #27 publishedAt all null this phase
test("publishedAt is null for every sealed candidate", () => {
  const sealed = buildSealedPredictions(fullInput(threeHundredFortyCandidates(), fortyBacktests()))
  for (const c of sealed.candidates) assert.equal(c.publishedAt, null)
  assert.equal(sealed.counts.publishedPredictionCount, 0)
})

// #30 v1 core fields unchanged (only predictionState flips to sealed)
test("sealing preserves every v1 core field except predictionState", () => {
  const candidates = threeHundredFortyCandidates()
  const sealed = buildSealedPredictions(fullInput(candidates, fortyBacktests()))
  const byId = new Map(candidates.map((c) => [c.id, c]))
  for (const s of sealed.candidates) {
    const original = byId.get(s.id)!
    assert.deepEqual(s.prediction, { ...original, predictionState: "sealed" })
    assert.equal(s.prediction.predictionState, "sealed")
    assert.deepEqual(s.prediction.probabilities, original.probabilities)
    assert.deepEqual(s.prediction.predictedScoreline, original.predictedScoreline)
    assert.deepEqual(s.prediction.confidence, original.confidence)
    assert.deepEqual(s.prediction.reasons, original.reasons)
    assert.deepEqual(s.prediction.elo, original.elo)
    assert.deepEqual(s.prediction.lambda, original.lambda)
  }
})

test("buildSealManifest locks officialPredictionCount=0 and officialAccuracy=null", () => {
  const m = buildSealManifest({
    competitionSlug: "premier-league",
    season: "2026-27",
    sealMode: "remaining_future_season_publication",
    sealedAt: SEALED_AT,
    sourceCommit: "e3a3ee2",
    sourcePredictionsHash: "a".repeat(64),
    eligibilityOverridesHash: "d".repeat(64),
    adjustmentLedgerHash: "b".repeat(64),
    sealedPredictionsHash: "c".repeat(64),
    effectiveCatalogHash: "e".repeat(64),
    totalPredictions: 380,
    originalBacktestCount: 40,
    lateBacktestCount: 10,
    sealedCandidateCount: 330,
    manualAdjustmentCount: 0,
  })
  assert.equal(m.officialPredictionCount, 0)
  assert.equal(m.officialAccuracy, null)
  assert.equal(m.publishedPredictionCount, 0)
  assert.equal(m.sealMode, "remaining_future_season_publication")
  assert.equal(m.totalBacktestCount, 50)
  assert.equal(m.originalBacktestCount, 40)
  assert.equal(m.lateBacktestCount, 10)
  assert.equal(m.sealedCandidateCount, 330)
})

test("lock policy forbids regeneration and adjustment after seal", () => {
  const policy = buildLockPolicy("premier-league", "2026-27")
  assert.equal(policy.allowRegenerationAfterSeal, false)
  assert.equal(policy.allowAdjustmentAfterSeal, false)
  assert.equal(policy.requiresPublicationBeforeOfficialEvaluation, true)
  assert.equal(policy.backtestsEligibleForOfficialAccuracy, false)
})

test("lock policy accepts the revised remaining-future seal mode", () => {
  const policy = buildLockPolicy("premier-league", "2026-27", "remaining_future_season_publication")
  assert.equal(policy.sealMode, "remaining_future_season_publication")
  assert.equal(policy.allowRegenerationAfterSeal, false)
  assert.equal(policy.allowAdjustmentAfterSeal, false)
})

/* --------------------------- revised mode: remaining-future seal --------------------------- */

function revisedInput() {
  const backtests = fortyBacktests()
  const candidates: PredictionArtifact[] = []
  for (let i = 0; i < 340; i++) {
    const kickoffUtc =
      i < 10
        ? `2026-06-${String((i % 28) + 1).padStart(2, "0")}T15:00:00Z`
        : `2026-08-${String((i % 28) + 1).padStart(2, "0")}T15:00:00Z`
    candidates.push(makeCandidate(`cand-${i}`, kickoffUtc))
  }
  return { predictions: [...backtests, ...candidates], sealedAt: SEALED_AT, competitionSlug: "premier-league", season: "2026-27" }
}

test("classifyCandidates splits 10 started candidates from 330 future", () => {
  const input = revisedInput()
  const candidates = input.predictions.filter((p) => p.predictionType === "candidate")
  const { lateBacktests, futureCandidates } = classifyCandidates(candidates, SEALED_AT)
  assert.equal(lateBacktests.length, 10)
  assert.equal(futureCandidates.length, 330)
  for (const c of lateBacktests) assert.ok(Date.parse(c.kickoffUtc) <= Date.parse(SEALED_AT))
  for (const c of futureCandidates) assert.ok(Date.parse(c.kickoffUtc) > Date.parse(SEALED_AT))
})

test("buildRemainingFutureSealedPredictions seals 330 future candidates and records 10 late backtests", () => {
  const sealed = buildRemainingFutureSealedPredictions(revisedInput())
  assert.equal(sealed.sealMode, "remaining_future_season_publication")
  assert.equal(sealed.candidates.length, 330)
  assert.equal(sealed.counts.sealedCandidateCount, 330)
  assert.equal(sealed.counts.originalBacktestCount, 40)
  assert.equal(sealed.counts.lateBacktestCount, 10)
  assert.equal(sealed.counts.totalBacktestCount, 50)
  assert.equal(sealed.backtests.originalCount, 40)
  assert.equal(sealed.backtests.lateCount, 10)
  assert.equal(sealed.backtests.totalCount, 50)
  for (const c of sealed.candidates) {
    assert.equal(c.predictionState, "sealed")
    assert.ok(Date.parse(c.sealedAt) < Date.parse(c.kickoffUtc))
  }
})

test("a started future candidate blocks the whole batch (no partial 329 seal)", () => {
  const input = revisedInput()
  const future = input.predictions.find((p) => p.predictionType === "candidate" && Date.parse(p.kickoffUtc) > Date.parse(SEALED_AT))!
  future.kickoffUtc = "2026-06-15T15:00:00Z" // an 11th started candidate
  assert.throws(() => buildRemainingFutureSealedPredictions(input), /exactly 10 late backtests/)
})

test("does not auto-shrink the batch when the future count drifts from 330", () => {
  const input = revisedInput()
  const future = input.predictions.filter((p) => p.predictionType === "candidate" && Date.parse(p.kickoffUtc) > Date.parse(SEALED_AT))
  future[0].kickoffUtc = "2026-06-15T15:00:00Z"
  future[1].kickoffUtc = "2026-06-16T15:00:00Z"
  assert.throws(() => buildRemainingFutureSealedPredictions(input), /exactly 10 late backtests/)
})
