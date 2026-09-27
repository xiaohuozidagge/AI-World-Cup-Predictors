/**
 * Tests for the prediction settlement layer (`computeEvaluation`).
 *
 * The function is pure: it reads only the frozen artifacts it is handed and
 * writes nothing, so these cases construct synthetic inputs in memory. No
 * network, no token, no filesystem.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { computeEvaluation, type EvaluationInput } from "./prediction-evaluation"
import { buildSealedPrediction, hashObject, type RemainingFutureSealedFile, type SealedPrediction } from "./prediction-lock"
import type { EffectiveCatalogFile, EligibilityOverridesFile } from "./prediction-classification"
import type { PredictionArtifact } from "../model/prediction-artifact"
import type { Fixture } from "../supabase/types"

const SEALED_AT = "2026-08-20T00:00:00Z"
const KICKOFF = "2026-08-21T19:00:00Z"

// --- factories ---------------------------------------------------------------

function makeArtifact(overrides: Partial<PredictionArtifact> = {}): PredictionArtifact {
  return {
    id: "arsenal-vs-villa-1001",
    slug: "arsenal-vs-villa-1001",
    competitionSlug: "premier-league",
    season: "2026-27",
    matchweek: 1,
    kickoffUtc: KICKOFF,
    homeTeam: { slug: "arsenal", name: "Arsenal", shortName: "Arsenal" },
    awayTeam: { slug: "aston-villa", name: "Aston Villa", shortName: "Villa" },
    predictionType: "candidate",
    predictionState: "unlocked",
    actualScore: null,
    predictedScoreline: { home: 2, away: 1 },
    modelVersion: "1.0.0",
    configHash: "abc123",
    generatedAt: "2026-08-01T00:00:00Z",
    dataCutoff: "2026-08-01T00:00:00Z",
    eligibleForOfficialAccuracy: false,
    probabilities: { home: 0.5, draw: 0.25, away: 0.25 },
    predictedResult: "H",
    topScorelines: [],
    confidence: { score: 0.6, level: "medium" },
    lambda: { home: 1.8, away: 0.9 },
    elo: { home: 1600, away: 1500 },
    reasons: [],
    ...overrides,
  }
}

function makeFixture(overrides: Partial<Fixture> & { providerFixtureId?: number } = {}): Fixture {
  const providerFixtureId = overrides.providerFixtureId ?? 1001
  return {
    id: `fx-${providerFixtureId}`,
    provider: "football-data",
    provider_fixture_id: providerFixtureId,
    competition_id: "pl-id",
    season: 2026,
    round: null,
    matchweek: 1,
    stage: "REGULAR_SEASON",
    home_team_id: "team-arsenal",
    away_team_id: "team-villa",
    kickoff_at: KICKOFF,
    venue_name: null,
    venue_city: null,
    status: "SCHEDULED",
    elapsed_minutes: null,
    home_score: null,
    away_score: null,
    halftime_home_score: null,
    halftime_away_score: null,
    fulltime_home_score: null,
    fulltime_away_score: null,
    winner_team_id: null,
    source_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function finishedFixture(providerFixtureId = 1001, home = 2, away = 1): Fixture {
  return makeFixture({
    providerFixtureId,
    status: "FINISHED",
    fulltime_home_score: home,
    fulltime_away_score: away,
    home_score: home,
    away_score: away,
    winner_team_id: home > away ? "team-arsenal" : home < away ? "team-villa" : null,
  })
}

function emptySealed(): RemainingFutureSealedFile {
  return {
    schemaVersion: 1,
    competitionSlug: "premier-league",
    season: "2026-27",
    sealMode: "remaining_future_season_publication",
    sealedAt: SEALED_AT,
    batchHash: "",
    backtests: { excluded: true, originalCount: 0, lateCount: 0, totalCount: 0, note: "" },
    counts: {
      totalPredictions: 0,
      originalBacktestCount: 0,
      lateBacktestCount: 0,
      totalBacktestCount: 0,
      sealedCandidateCount: 0,
      publishedPredictionCount: 0,
    },
    candidates: [],
  }
}

function emptyOverrides(): EligibilityOverridesFile {
  return {
    schemaVersion: 1,
    competitionSlug: "premier-league",
    season: "2026-27",
    detectedAt: SEALED_AT,
    lateBacktestCount: 0,
    overrides: [],
  }
}

function emptyCatalog(): EffectiveCatalogFile {
  return {
    schemaVersion: 1,
    competitionSlug: "premier-league",
    season: "2026-27",
    totalPredictions: 0,
    originalBacktestCount: 0,
    lateBacktestCount: 0,
    totalBacktestCount: 0,
    sealedCandidateCount: 0,
    publishedPredictionCount: 0,
    entries: [],
  }
}

function makeInput(overrides: Partial<EvaluationInput>): EvaluationInput {
  return {
    predictions: [],
    sealed: emptySealed(),
    overrides: emptyOverrides(),
    catalog: emptyCatalog(),
    fixtures: [],
    competitionSlug: "premier-league",
    season: "2026-27",
    evaluatedAt: "2026-09-20T00:00:00Z",
    resultDataCutoff: "2026-09-19T00:00:00Z",
    ...overrides,
  }
}

/** Simulate the future publication of a sealed candidate (publishedAt is null today). */
function publish(candidate: SealedPrediction, publishedAt: string): SealedPrediction {
  return { ...candidate, publishedAt } as unknown as SealedPrediction
}

function sealedCandidatesFrom(pred: PredictionArtifact): RemainingFutureSealedFile {
  const sealed = buildSealedPrediction(pred, SEALED_AT)
  const file = emptySealed()
  file.counts.totalPredictions = 1
  file.counts.sealedCandidateCount = 1
  file.candidates = [sealed]
  return file
}

/** Reclassify a candidate as a permanently-ineligible post-event reconstruction. */
function reconstructionOverrides(pred: PredictionArtifact): EligibilityOverridesFile {
  const overrides = emptyOverrides()
  overrides.lateBacktestCount = 1
  overrides.overrides = [
    {
      matchId: pred.slug,
      originalPredictionType: "candidate",
      effectivePredictionType: "backtest",
      effectivePredictionState: "post_event_reconstruction",
      kickoffUtc: KICKOFF,
      generatedAt: pred.generatedAt,
      detectedAt: SEALED_AT,
      startedBeforeGeneration: false,
      startedBeforeSeal: true,
      eligibleForOfficialAccuracy: false,
      permanentlyIneligible: true,
      reason: "generated_or_sealed_after_kickoff",
      originalPredictionHash: hashObject(pred),
    },
  ]
  return overrides
}

// --- tests -------------------------------------------------------------------

test("original backtests are never official", () => {
  const backtest = makeArtifact({
    predictionType: "backtest",
    predictionState: "historical_reconstruction",
    actualScore: { home: 2, away: 1 },
  })
  const input = makeInput({ predictions: [backtest] })
  const result = computeEvaluation(input)
  assert.equal(result.categories.originalBacktest.eligible, false)
  assert.equal(result.categories.originalBacktest.sampleCount, 1)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 0)
  assert.equal(result.categories.officialSealed.officialAccuracy, null)
})

test("historical reconstructions are never official", () => {
  const pred = makeArtifact({ predictionType: "candidate" })
  const overrides = emptyOverrides()
  overrides.lateBacktestCount = 1
  overrides.overrides = [
    {
      matchId: pred.slug,
      originalPredictionType: "candidate",
      effectivePredictionType: "backtest",
      effectivePredictionState: "post_event_reconstruction",
      kickoffUtc: KICKOFF,
      generatedAt: pred.generatedAt,
      detectedAt: SEALED_AT,
      startedBeforeGeneration: false,
      startedBeforeSeal: true,
      eligibleForOfficialAccuracy: false,
      permanentlyIneligible: true,
      reason: "generated_or_sealed_after_kickoff",
      originalPredictionHash: hashObject(pred),
    },
  ]
  const input = makeInput({
    predictions: [pred],
    overrides,
    fixtures: [finishedFixture(1001, 2, 1)],
  })
  const result = computeEvaluation(input)
  assert.equal(result.categories.historicalReconstruction.eligible, false)
  assert.equal(result.categories.historicalReconstruction.sampleCount, 1)
  assert.equal(result.categories.historicalReconstruction.settledCount, 1)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 0)
})

test("a historical reconstruction stays permanently non-official after its fixture finishes", () => {
  const pred = makeArtifact({ predictionType: "candidate" })
  const overrides = reconstructionOverrides(pred)

  // Before the result lands (TIMED), the reconstruction is already category B.
  const before = computeEvaluation(
    makeInput({ predictions: [pred], overrides, fixtures: [makeFixture({ providerFixtureId: 1001, status: "TIMED" })] }),
  )
  assert.equal(before.categories.historicalReconstruction.sampleCount, 1)
  assert.equal(before.categories.historicalReconstruction.settledCount, 0)
  assert.equal(before.categories.historicalReconstruction.eligible, false)

  // The sync only updates the actual result (TIMED -> FINISHED). It settles, but
  // the classification must never migrate to official.
  const after = computeEvaluation(
    makeInput({ predictions: [pred], overrides, fixtures: [finishedFixture(1001, 2, 1)] }),
  )
  assert.equal(after.categories.historicalReconstruction.sampleCount, 1)
  assert.equal(after.categories.historicalReconstruction.settledCount, 1)
  assert.equal(after.categories.historicalReconstruction.eligible, false)
  assert.equal(after.categories.officialSealed.officialEvaluatedCount, 0)
  assert.equal(after.categories.officialSealed.officialAccuracy, null)
})

test("skipping a live (IN_PLAY -> LIVE) fixture does not change a reconstruction's classification", () => {
  const pred = makeArtifact({ predictionType: "candidate" })
  const overrides = reconstructionOverrides(pred)

  const input = makeInput({
    predictions: [pred],
    overrides,
    fixtures: [makeFixture({ providerFixtureId: 1001, status: "LIVE" })],
  })
  const result = computeEvaluation(input)

  // A live match has no final score, so it is not settled…
  assert.equal(result.categories.historicalReconstruction.settledCount, 0)
  // …but its classification is unchanged: still B, still permanently non-official.
  assert.equal(result.categories.historicalReconstruction.sampleCount, 1)
  assert.equal(result.categories.historicalReconstruction.eligible, false)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 0)
})

test("a sealed but unpublished candidate is not official", () => {
  const pred = makeArtifact()
  const sealed = sealedCandidatesFrom(pred)
  const input = makeInput({
    predictions: [pred],
    sealed,
    fixtures: [finishedFixture(1001, 2, 1)],
  })
  const result = computeEvaluation(input)
  assert.equal(result.categories.officialSealed.candidateCount, 1)
  assert.equal(result.categories.officialSealed.publishedCount, 0)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 0)
  assert.equal(result.categories.officialSealed.officialAccuracy, null)
})

test("a candidate published after kickoff is not official", () => {
  const pred = makeArtifact()
  const file = sealedCandidatesFrom(pred)
  const afterKickoff = "2026-08-22T00:00:00Z"
  file.candidates = [publish(file.candidates[0], afterKickoff)]
  const input = makeInput({
    predictions: [pred],
    sealed: file,
    fixtures: [finishedFixture(1001, 2, 1)],
  })
  const result = computeEvaluation(input)
  assert.equal(result.categories.officialSealed.publishedCount, 1)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 0)
  assert.equal(result.categories.officialSealed.officialAccuracy, null)
})

test("a candidate published before kickoff with a finished result is official", () => {
  const pred = makeArtifact()
  const file = sealedCandidatesFrom(pred)
  file.candidates = [publish(file.candidates[0], "2026-08-21T00:00:00Z")]
  const input = makeInput({
    predictions: [pred],
    sealed: file,
    fixtures: [finishedFixture(1001, 2, 1)],
  })
  const result = computeEvaluation(input)
  assert.equal(result.categories.officialSealed.publishedCount, 1)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 1)
  assert.equal(result.categories.officialSealed.officialAccuracy, 1) // predicted H, actual 2-1 = H
})

test("a cancelled fixture is never settled or official", () => {
  const pred = makeArtifact()
  const file = sealedCandidatesFrom(pred)
  file.candidates = [publish(file.candidates[0], "2026-08-21T00:00:00Z")]
  const cancelled = makeFixture({ providerFixtureId: 1001, status: "CANCELLED" })
  const input = makeInput({
    predictions: [pred],
    sealed: file,
    fixtures: [cancelled],
  })
  const result = computeEvaluation(input)
  assert.equal(result.categories.officialSealed.settledCount, 0)
  assert.equal(result.categories.officialSealed.officialEvaluatedCount, 0)
  assert.equal(result.categories.officialSealed.officialAccuracy, null)
})

test("zero samples produce null accuracy, not 0%", () => {
  const input = makeInput({})
  const result = computeEvaluation(input)
  assert.equal(result.categories.officialSealed.officialAccuracy, null)
  assert.equal(result.categories.originalBacktest.metrics?.sampleCount ?? 0, 0)
  assert.equal(result.categories.originalBacktest.metrics?.oneX2Accuracy ?? null, null)
})

test("computeEvaluation does not mutate its inputs", () => {
  const pred = makeArtifact()
  const sealed = sealedCandidatesFrom(pred)
  const fixtures = [finishedFixture(1001, 2, 1)]
  const before = JSON.stringify({ pred, sealed, fixtures })
  const input = makeInput({ predictions: [pred], sealed, fixtures })
  computeEvaluation(input)
  const after = JSON.stringify({ pred, sealed, fixtures })
  assert.equal(after, before)
})

test("repeated computation over identical inputs is byte-identical", () => {
  const pred = makeArtifact()
  const sealed = sealedCandidatesFrom(pred)
  const input = makeInput({ predictions: [pred], sealed, fixtures: [finishedFixture(1001, 2, 1)] })
  const a = JSON.stringify(computeEvaluation(input))
  const b = JSON.stringify(computeEvaluation(input))
  assert.equal(a, b)
})
