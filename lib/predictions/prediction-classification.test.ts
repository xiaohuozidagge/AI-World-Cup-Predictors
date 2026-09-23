/**
 * Tests for the revised Phase VIII classification layer: already-started
 * candidates are derived into permanently-ineligible "late backtests", the Phase
 * VII predictions are never mutated, and the effective catalog spans all 380
 * predictions as 40 original backtests + 10 late backtests + 330 sealed candidates.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { PredictionArtifact, PredictionReason } from "../model/prediction-artifact"
import { buildRemainingFutureSealedPredictions, classifyCandidates, hashObject } from "./prediction-lock"
import {
  buildEffectiveCatalog,
  buildEligibilityOverridesFile,
  buildLateBacktestOverride,
  isReclassifiableToCandidate,
  type EffectiveCatalogFile,
  type EligibilityOverridesFile,
} from "./prediction-classification"

const SEALED_AT = "2026-09-22T12:54:59Z"

/** The exact 10 candidates that had already kicked off at the first dry-run. */
const REAL_LATE: Array<[id: string, kickoffUtc: string]> = [
  ["pl-2026-27-brentford-fc-vs-chelsea-fc-560591", "2026-09-18T19:00:00Z"],
  ["pl-2026-27-tottenham-hotspur-fc-vs-aston-villa-fc-560587", "2026-09-19T11:30:00Z"],
  ["pl-2026-27-brighton-hove-albion-fc-vs-arsenal-fc-560586", "2026-09-19T14:00:00Z"],
  ["pl-2026-27-everton-fc-vs-ipswich-town-fc-560584", "2026-09-19T14:00:00Z"],
  ["pl-2026-27-newcastle-united-fc-vs-hull-city-afc-560588", "2026-09-19T14:00:00Z"],
  ["pl-2026-27-nottingham-forest-fc-vs-coventry-city-fc-560589", "2026-09-19T16:30:00Z"],
  ["pl-2026-27-afc-bournemouth-vs-liverpool-fc-560582", "2026-09-20T13:00:00Z"],
  ["pl-2026-27-leeds-united-fc-vs-crystal-palace-fc-560585", "2026-09-20T13:00:00Z"],
  ["pl-2026-27-manchester-city-fc-vs-sunderland-afc-560590", "2026-09-20T13:00:00Z"],
  ["pl-2026-27-fulham-fc-vs-manchester-united-fc-560583", "2026-09-20T15:30:00Z"],
]

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

function makeBacktest(id: string): PredictionArtifact {
  const p = makeCandidate(id, "2026-05-01T15:00:00Z")
  p.predictionType = "backtest"
  p.predictionState = "historical_reconstruction"
  p.actualScore = { home: 1, away: 0 }
  return p
}

function buildCatalog(): { catalog: EffectiveCatalogFile; overrides: EligibilityOverridesFile } {
  const originalBacktests = Array.from({ length: 40 }, (_, i) => makeBacktest(`bt-${i}`))
  const lateCandidates = REAL_LATE.map(([id, kickoffUtc]) => makeCandidate(id, kickoffUtc))
  const futureCandidates = Array.from({ length: 330 }, (_, i) => makeCandidate(`fut-${i}`, "2026-09-25T15:00:00Z"))
  const candidates = [...lateCandidates, ...futureCandidates]
  const predictions = [...originalBacktests, ...candidates]

  const { lateBacktests } = classifyCandidates(candidates, SEALED_AT)
  const sealed = buildRemainingFutureSealedPredictions({
    predictions,
    sealedAt: SEALED_AT,
    competitionSlug: "premier-league",
    season: "2026-27",
  })
  const overrides = buildEligibilityOverridesFile({
    competitionSlug: "premier-league",
    season: "2026-27",
    detectedAt: SEALED_AT,
    lateBacktests,
  })
  const catalog = buildEffectiveCatalog({
    competitionSlug: "premier-league",
    season: "2026-27",
    originalBacktests,
    overrides: overrides.overrides,
    sealedCandidates: sealed.candidates,
  })
  return { catalog, overrides }
}

// #1 started candidate → derived post_event_reconstruction late backtest
test("buildLateBacktestOverride derives a post_event_reconstruction late backtest", () => {
  const c = makeCandidate("pl-2026-27-brentford-fc-vs-chelsea-fc-560591", "2026-09-18T19:00:00Z")
  const o = buildLateBacktestOverride(c, SEALED_AT)
  assert.equal(o.originalPredictionType, "candidate")
  assert.equal(o.effectivePredictionType, "backtest")
  assert.equal(o.effectivePredictionState, "post_event_reconstruction")
  assert.equal(o.permanentlyIneligible, true)
  assert.equal(o.eligibleForOfficialAccuracy, false)
  assert.equal(o.reason, "generated_or_sealed_after_kickoff")
  assert.equal(o.originalPredictionHash, hashObject(c))
  assert.equal(o.startedBeforeGeneration, true)
  assert.equal(o.startedBeforeSeal, true)
  assert.equal(o.kickoffUtc, "2026-09-18T19:00:00Z")
  assert.equal(o.generatedAt, c.generatedAt)
})

// #2 Phase VII predictions are never mutated
test("building overrides and catalog never mutates the Phase VII predictions", () => {
  const originalBacktests = Array.from({ length: 40 }, (_, i) => makeBacktest(`bt-${i}`))
  const candidates = [
    ...REAL_LATE.map(([id, kickoffUtc]) => makeCandidate(id, kickoffUtc)),
    ...Array.from({ length: 330 }, (_, i) => makeCandidate(`fut-${i}`, "2026-09-25T15:00:00Z")),
  ]
  const before = JSON.parse(JSON.stringify([...originalBacktests, ...candidates]))
  const { lateBacktests } = classifyCandidates(candidates, SEALED_AT)
  buildEligibilityOverridesFile({ competitionSlug: "premier-league", season: "2026-27", detectedAt: SEALED_AT, lateBacktests })
  assert.deepEqual([...originalBacktests, ...candidates], before)
})

// #5 the classified late-backtest list matches the prior dry-run list exactly
test("classifyCandidates identifies exactly the 10 real late backtests", () => {
  const candidates = [
    ...REAL_LATE.map(([id, kickoffUtc]) => makeCandidate(id, kickoffUtc)),
    ...Array.from({ length: 330 }, (_, i) => makeCandidate(`fut-${i}`, "2026-09-25T15:00:00Z")),
  ]
  const { lateBacktests, futureCandidates } = classifyCandidates(candidates, SEALED_AT)
  assert.equal(lateBacktests.length, 10)
  assert.equal(futureCandidates.length, 330)
  assert.deepEqual(
    lateBacktests.map((c) => c.id).sort(),
    REAL_LATE.map(([id]) => id).sort(),
  )
})

// #9 + #10 effective catalog spans 380 = 40 + 10 + 330
test("effective catalog covers 380 predictions as 40/10/330", () => {
  const { catalog } = buildCatalog()
  assert.equal(catalog.totalPredictions, 380)
  assert.equal(catalog.entries.length, 380)
  assert.equal(catalog.originalBacktestCount, 40)
  assert.equal(catalog.lateBacktestCount, 10)
  assert.equal(catalog.totalBacktestCount, 50)
  assert.equal(catalog.sealedCandidateCount, 330)

  const backtests = catalog.entries.filter((e) => e.effectivePredictionType === "backtest")
  const sealed = catalog.entries.filter((e) => e.effectivePredictionType === "candidate")
  assert.equal(backtests.length, 50)
  assert.equal(sealed.length, 330)
  assert.equal(backtests.filter((e) => e.effectivePredictionState === "historical_reconstruction").length, 40)
  assert.equal(backtests.filter((e) => e.effectivePredictionState === "post_event_reconstruction").length, 10)
})

// #11 original prediction hash is preserved per entry
test("catalog preserves the original prediction hash", () => {
  const { catalog } = buildCatalog()
  const late = catalog.entries.find((e) => e.effectivePredictionState === "post_event_reconstruction")!
  const original = makeCandidate(late.matchId, "2026-09-18T19:00:00Z")
  assert.equal(late.originalPredictionHash, hashObject(original))
  assert.equal(late.finalPredictionHash, late.originalPredictionHash)

  const sealed = catalog.entries.find((e) => e.effectivePredictionState === "sealed")!
  const sealedOriginal = makeCandidate(sealed.matchId, "2026-09-25T15:00:00Z")
  assert.equal(sealed.originalPredictionHash, hashObject(sealedOriginal))
  assert.equal(sealed.finalPredictionHash, hashObject({ ...sealedOriginal, predictionState: "sealed" }))
})

// #12 core prediction fields are byte-identical through sealing
test("sealing preserves every v1 core field except predictionState", () => {
  const candidates = [
    ...REAL_LATE.map(([id, kickoffUtc]) => makeCandidate(id, kickoffUtc)),
    ...Array.from({ length: 330 }, (_, i) => makeCandidate(`fut-${i}`, "2026-09-25T15:00:00Z")),
  ]
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const sealed = buildRemainingFutureSealedPredictions({
    predictions: [...Array.from({ length: 40 }, (_, i) => makeBacktest(`bt-${i}`)), ...candidates],
    sealedAt: SEALED_AT,
    competitionSlug: "premier-league",
    season: "2026-27",
  })
  for (const s of sealed.candidates) {
    const original = byId.get(s.id)!
    assert.deepEqual(s.prediction, { ...original, predictionState: "sealed" })
    assert.deepEqual(s.prediction.probabilities, original.probabilities)
    assert.deepEqual(s.prediction.predictedScoreline, original.predictedScoreline)
    assert.equal(s.prediction.predictedResult, original.predictedResult)
    assert.deepEqual(s.prediction.confidence, original.confidence)
    assert.deepEqual(s.prediction.reasons, original.reasons)
    assert.deepEqual(s.prediction.elo, original.elo)
    assert.deepEqual(s.prediction.lambda, original.lambda)
  }
})

// #20 a late backtest can never be reclassified back to a candidate
test("a late backtest is never reclassifiable to a candidate", () => {
  const { catalog } = buildCatalog()
  const late = catalog.entries.find((e) => e.effectivePredictionState === "post_event_reconstruction")!
  const historical = catalog.entries.find((e) => e.effectivePredictionState === "historical_reconstruction")!
  const sealedEntry = catalog.entries.find((e) => e.effectivePredictionState === "sealed")!
  assert.equal(late.effectivePredictionType, "backtest")
  assert.equal(late.permanentlyIneligible, true)
  assert.equal(isReclassifiableToCandidate(late), false)
  assert.equal(isReclassifiableToCandidate(historical), false)
  assert.equal(isReclassifiableToCandidate(sealedEntry), true)
})
