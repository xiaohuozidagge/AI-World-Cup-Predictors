/**
 * Premier League prediction settlement (Phase XIII-B evaluation layer).
 *
 * Reads the frozen prediction artifacts — `predictions.json`, the revised seal
 * snapshot, the eligibility overrides and the effective catalog — and settles
 * them against the *current* fixture statuses from `data/football/fixtures.json`.
 * It never writes to the sealed prediction directory and never mutates a
 * prediction: it is a read-only overlay that reports, per category, whether the
 * result arrived and how the prediction fared.
 *
 * Categories:
 *   A. Original Backtest (40)          — always non-official.
 *   B. Historical Reconstruction (10)  — always non-official.
 *   C. Official Sealed Predictions (330) — official only when: sealed candidate
 *      AND `sealedAt < kickoff` AND `publishedAt < kickoff` AND the fixture is
 *      FINISHED with a complete score AND the seal hash verifies AND it is not
 *      CANCELLED/VOID. Until publication happens, published=0 and official=null.
 *
 * Zero-sample metrics are `null`, never `0%`.
 */

import type { Fixture } from "../supabase/types"
import type { Result, ConfidenceLevel } from "../model/types"
import type { PredictionArtifact } from "../model/prediction-artifact"
import { hashObject, type RemainingFutureSealedFile, type SealedPrediction } from "./prediction-lock"
import type { EffectiveCatalogFile, EligibilityOverridesFile } from "./prediction-classification"

// --- metrics -----------------------------------------------------------------

export interface CategoryMetrics {
  sampleCount: number
  oneX2Accuracy: number | null
  exactScoreAccuracy: number | null
  brierScore: number | null
  logLoss: number | null
  predictedDistribution: Record<Result, number>
  actualDistribution: Record<Result, number>
  confusionMatrix: Record<Result, Record<Result, number>>
  confidenceLevels: Record<ConfidenceLevel, { count: number; oneX2Accuracy: number | null }>
}

interface SettledSample {
  actualScore: { home: number; away: number }
  predictedResult: Result
  predictedScoreline: { home: number; away: number }
  probabilities: { home: number; draw: number; away: number }
  confidenceLevel: ConfidenceLevel
}

function resultFromScore(score: { home: number; away: number }): Result {
  if (score.home > score.away) return "H"
  if (score.home < score.away) return "A"
  return "D"
}

function emptyMetrics(): CategoryMetrics {
  const zero: Record<Result, number> = { H: 0, D: 0, A: 0 }
  return {
    sampleCount: 0,
    oneX2Accuracy: null,
    exactScoreAccuracy: null,
    brierScore: null,
    logLoss: null,
    predictedDistribution: { ...zero },
    actualDistribution: { ...zero },
    confusionMatrix: { H: { ...zero }, D: { ...zero }, A: { ...zero } },
    confidenceLevels: {
      low: { count: 0, oneX2Accuracy: null },
      medium: { count: 0, oneX2Accuracy: null },
      high: { count: 0, oneX2Accuracy: null },
    },
  }
}

function computeMetrics(samples: SettledSample[]): CategoryMetrics {
  if (samples.length === 0) return emptyMetrics()

  const zero: Record<Result, number> = { H: 0, D: 0, A: 0 }
  const predictedDistribution: Record<Result, number> = { ...zero }
  const actualDistribution: Record<Result, number> = { ...zero }
  const confusionMatrix: Record<Result, Record<Result, number>> = {
    H: { ...zero },
    D: { ...zero },
    A: { ...zero },
  }
  const confidence = {
    low: { count: 0, correct: 0 },
    medium: { count: 0, correct: 0 },
    high: { count: 0, correct: 0 },
  }

  let correct1x2 = 0
  let correctExact = 0
  let brierSum = 0
  let logLossSum = 0

  for (const s of samples) {
    const actual = resultFromScore(s.actualScore)
    const pred = s.predictedResult
    if (pred === actual) correct1x2++
    if (s.predictedScoreline.home === s.actualScore.home && s.predictedScoreline.away === s.actualScore.away) {
      correctExact++
    }

    const oneHot = { H: actual === "H" ? 1 : 0, D: actual === "D" ? 1 : 0, A: actual === "A" ? 1 : 0 }
    brierSum +=
      (s.probabilities.home - oneHot.H) ** 2 +
      (s.probabilities.draw - oneHot.D) ** 2 +
      (s.probabilities.away - oneHot.A) ** 2

    const pActual = actual === "H" ? s.probabilities.home : actual === "D" ? s.probabilities.draw : s.probabilities.away
    logLossSum += -Math.log(Math.max(pActual, 1e-12))

    predictedDistribution[pred]++
    actualDistribution[actual]++
    confusionMatrix[pred][actual]++
    const bucket = confidence[s.confidenceLevel]
    bucket.count++
    if (pred === actual) bucket.correct++
  }

  const n = samples.length
  return {
    sampleCount: n,
    oneX2Accuracy: correct1x2 / n,
    exactScoreAccuracy: correctExact / n,
    brierScore: brierSum / n,
    logLoss: logLossSum / n,
    predictedDistribution,
    actualDistribution,
    confusionMatrix,
    confidenceLevels: {
      low: { count: confidence.low.count, oneX2Accuracy: confidence.low.count > 0 ? confidence.low.correct / confidence.low.count : null },
      medium: { count: confidence.medium.count, oneX2Accuracy: confidence.medium.count > 0 ? confidence.medium.correct / confidence.medium.count : null },
      high: { count: confidence.high.count, oneX2Accuracy: confidence.high.count > 0 ? confidence.high.correct / confidence.high.count : null },
    },
  }
}

// --- category results --------------------------------------------------------

export interface NonOfficialCategoryResult {
  eligible: false
  note: string
  sampleCount: number
  settledCount: number
  metrics: CategoryMetrics | null
}

export interface OfficialSealedResult {
  candidateCount: number
  publishedCount: number
  officialEvaluatedCount: number
  officialAccuracy: number | null
  /** Informational only: how many sealed candidates have a FINISHED result now. */
  settledCount: number
  settledMetrics: CategoryMetrics | null
  note: string
}

export interface EvaluationResult {
  schemaVersion: 1
  competitionSlug: string
  season: string
  evaluatedAt: string
  predictionDataCutoff: string | null
  resultDataCutoff: string | null
  fixtureStatus: { total: number; finished: number; notStarted: number; other: number }
  categories: {
    originalBacktest: NonOfficialCategoryResult
    historicalReconstruction: NonOfficialCategoryResult
    officialSealed: OfficialSealedResult
  }
}

// --- inputs ------------------------------------------------------------------

export interface EvaluationInput {
  predictions: PredictionArtifact[]
  sealed: RemainingFutureSealedFile
  overrides: EligibilityOverridesFile
  catalog: EffectiveCatalogFile
  fixtures: Fixture[]
  competitionSlug: string
  season: string
  evaluatedAt: string
  resultDataCutoff: string | null
}

function providerIdFromSlug(slug: string): number | null {
  const m = /-(\d+)$/.exec(slug)
  return m ? Number(m[1]) : null
}

function actualScoreFromFixture(fixture: Fixture | undefined): { home: number; away: number } | null {
  if (!fixture || fixture.status !== "FINISHED") return null
  if (!Number.isInteger(fixture.fulltime_home_score) || !Number.isInteger(fixture.fulltime_away_score)) return null
  return { home: fixture.fulltime_home_score as number, away: fixture.fulltime_away_score as number }
}

function isSealHashValid(candidate: SealedPrediction, original: PredictionArtifact | undefined): boolean {
  if (!original) return false
  return (
    candidate.finalPredictionHash === hashObject(candidate.prediction) &&
    candidate.originalPredictionHash === hashObject(original)
  )
}

/**
 * Compute the settlement overlay. Pure: reads no files, writes nothing.
 */
export function computeEvaluation(input: EvaluationInput): EvaluationResult {
  const fixturesByProviderId = new Map(input.fixtures.map((f) => [f.provider_fixture_id, f]))
  const predictionsBySlug = new Map(input.predictions.map((p) => [p.slug, p]))

  const fixtureOf = (slug: string): Fixture | undefined => {
    const id = providerIdFromSlug(slug)
    return id === null ? undefined : fixturesByProviderId.get(id)
  }

  const settled = (pred: PredictionArtifact): SettledSample | null => {
    const score = actualScoreFromFixture(fixtureOf(pred.slug))
    if (!score) return null
    return {
      actualScore: score,
      predictedResult: pred.predictedResult,
      predictedScoreline: pred.predictedScoreline,
      probabilities: pred.probabilities,
      confidenceLevel: pred.confidence.level,
    }
  }

  // A. Original backtests — 40, always have their own actualScore.
  const originalBacktests = input.predictions.filter((p) => p.predictionType === "backtest")
  const backtestSamples: SettledSample[] = []
  for (const b of originalBacktests) {
    if (b.actualScore) {
      backtestSamples.push({
        actualScore: b.actualScore,
        predictedResult: b.predictedResult,
        predictedScoreline: b.predictedScoreline,
        probabilities: b.probabilities,
        confidenceLevel: b.confidence.level,
      })
    }
  }

  // B. Historical reconstruction — the 10 late backtests (candidates that started
  //    before generation/seal, reclassified by the eligibility overrides).
  const reconstructionSamples: SettledSample[] = []
  let reconstructionSettled = 0
  for (const o of input.overrides.overrides) {
    const pred = predictionsBySlug.get(o.matchId)
    if (!pred) continue
    const s = settled(pred)
    if (s) {
      reconstructionSamples.push(s)
      reconstructionSettled++
    }
  }

  // C. Official sealed predictions.
  const sealedCandidates = input.sealed.candidates
  let publishedCount = 0
  let officialEvaluatedCount = 0
  let officialCorrect = 0
  const officialSamples: SettledSample[] = []
  const settledSamples: SettledSample[] = []
  let sealedSettled = 0

  for (const candidate of sealedCandidates) {
    const fixture = fixtureOf(candidate.slug)
    const score = actualScoreFromFixture(fixture)
    const original = predictionsBySlug.get(candidate.id)
    const sealValid = isSealHashValid(candidate, original)

    if (candidate.publishedAt != null) publishedCount++

    // Official sample only if every publication + settlement condition holds.
    if (score && sealValid && candidate.publishedAt != null) {
      const sealedBefore = Date.parse(candidate.sealedAt) < Date.parse(candidate.kickoffUtc)
      const publishedBefore = Date.parse(candidate.publishedAt) < Date.parse(candidate.kickoffUtc)
      if (sealedBefore && publishedBefore) {
        const sample: SettledSample = {
          actualScore: score,
          predictedResult: candidate.prediction.predictedResult,
          predictedScoreline: candidate.prediction.predictedScoreline,
          probabilities: candidate.prediction.probabilities,
          confidenceLevel: candidate.prediction.confidence.level,
        }
        officialSamples.push(sample)
        officialEvaluatedCount++
        if (sample.predictedResult === resultFromScore(score)) officialCorrect++
      }
    }

    // Informational settlement (independent of publication).
    if (score) {
      sealedSettled++
      settledSamples.push({
        actualScore: score,
        predictedResult: candidate.prediction.predictedResult,
        predictedScoreline: candidate.prediction.predictedScoreline,
        probabilities: candidate.prediction.probabilities,
        confidenceLevel: candidate.prediction.confidence.level,
      })
    }
  }

  const finishedCount = input.fixtures.filter((f) => f.status === "FINISHED").length
  const notStartedCount = input.fixtures.filter((f) => f.status === "SCHEDULED" || f.status === "TIMED").length

  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    evaluatedAt: input.evaluatedAt,
    predictionDataCutoff: input.predictions[0]?.dataCutoff ?? null,
    resultDataCutoff: input.resultDataCutoff,
    fixtureStatus: {
      total: input.fixtures.length,
      finished: finishedCount,
      notStarted: notStartedCount,
      other: input.fixtures.length - finishedCount - notStartedCount,
    },
    categories: {
      originalBacktest: {
        eligible: false,
        note: "original backtests are permanent historical reconstructions; never official",
        sampleCount: originalBacktests.length,
        settledCount: backtestSamples.length,
        metrics: computeMetrics(backtestSamples),
      },
      historicalReconstruction: {
        eligible: false,
        note: "late backtests are permanent post-event reconstructions; never official",
        sampleCount: input.overrides.overrides.length,
        settledCount: reconstructionSettled,
        metrics: reconstructionSamples.length > 0 ? computeMetrics(reconstructionSamples) : null,
      },
      officialSealed: {
        candidateCount: sealedCandidates.length,
        publishedCount,
        officialEvaluatedCount,
        officialAccuracy: officialEvaluatedCount > 0 ? officialCorrect / officialEvaluatedCount : null,
        settledCount: sealedSettled,
        settledMetrics: settledSamples.length > 0 ? computeMetrics(settledSamples) : null,
        note: "official accuracy requires publication before kickoff; publishedAt is null until first release",
      },
    },
  }
}
