/**
 * Backtest evaluation metrics: 1X2 accuracy, exact-score accuracy, home/away/
 * total-goals MAE, "both scores within ±1 goal", multiclass Brier score,
 * multiclass log loss, average confidence, accuracy by confidence level, by
 * season, and by outcome, plus per-outcome probability-calibration buckets.
 * Pure and deterministic.
 */

import type { ConfidenceLevel, MatchPrediction, OneX2Probabilities, Result } from "./types"

const EPS = 1e-12
const OUTCOMES: Result[] = ["H", "D", "A"]

function probabilityFor(p: OneX2Probabilities, outcome: Result): number {
  return outcome === "H" ? p.home : outcome === "D" ? p.draw : p.away
}

function safeMean(values: number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

export interface AccuracyByConfidence {
  matches: number
  accuracy: number
}

export interface SeasonStats {
  matches: number
  accuracy1X2: number
  logLoss: number
}

export interface OutcomeStats {
  matches: number
  accuracy: number
}

export interface PredictionMetrics {
  matchCount: number
  accuracy1X2: number
  exactScoreAccuracy: number
  /** Mean absolute error of predicted vs actual home goals. */
  homeGoalsMAE: number
  /** Mean absolute error of predicted vs actual away goals. */
  awayGoalsMAE: number
  /** Mean absolute error of predicted vs actual total goals. */
  totalGoalsMAE: number
  /** Fraction of matches where both teams' expected goals are within ±1 of actual. */
  bothWithinOneGoal: number
  brierScore: number
  logLoss: number
  averageConfidenceScore: number
  accuracyByConfidence: Record<ConfidenceLevel, AccuracyByConfidence>
  bySeason: Record<string, SeasonStats>
  byOutcome: Record<Result, OutcomeStats>
}

/** Evaluate a set of predictions (same set used for the backtest report). */
export function computeMetrics(predictions: MatchPrediction[]): PredictionMetrics {
  const n = predictions.length

  const correct1X2 = predictions.filter((p) => p.predictedResult === p.actualResult).length
  const exact = predictions.filter(
    (p) => p.predictedScoreline.home === p.actualHomeGoals && p.predictedScoreline.away === p.actualAwayGoals,
  ).length

  const homeErrors: number[] = []
  const awayErrors: number[] = []
  const totalErrors: number[] = []
  const briers: number[] = []
  const logLosses: number[] = []
  let withinOne = 0

  const byConfidence: Record<ConfidenceLevel, { correct: number; total: number }> = {
    low: { correct: 0, total: 0 },
    medium: { correct: 0, total: 0 },
    high: { correct: 0, total: 0 },
  }
  const bySeason: Record<string, { correct: number; total: number; logLossSum: number }> = {}
  const byOutcome: Record<Result, { correct: number; total: number }> = {
    H: { correct: 0, total: 0 },
    D: { correct: 0, total: 0 },
    A: { correct: 0, total: 0 },
  }

  for (const p of predictions) {
    homeErrors.push(Math.abs(p.lambdaHome - p.actualHomeGoals))
    awayErrors.push(Math.abs(p.lambdaAway - p.actualAwayGoals))
    totalErrors.push(Math.abs(p.lambdaHome + p.lambdaAway - (p.actualHomeGoals + p.actualAwayGoals)))
    if (Math.abs(p.lambdaHome - p.actualHomeGoals) <= 1 && Math.abs(p.lambdaAway - p.actualAwayGoals) <= 1) withinOne++

    const y = { H: 0, D: 0, A: 0 }
    y[p.actualResult] = 1
    const ph = p.probabilities
    briers.push((ph.home - y.H) ** 2 + (ph.draw - y.D) ** 2 + (ph.away - y.A) ** 2)

    const pTrue = probabilityFor(p.probabilities, p.actualResult)
    logLosses.push(-Math.log(Math.max(pTrue, EPS)))

    const cb = byConfidence[p.confidence]
    cb.total += 1
    if (p.predictedResult === p.actualResult) cb.correct += 1

    const sb = bySeason[p.season] ?? (bySeason[p.season] = { correct: 0, total: 0, logLossSum: 0 })
    sb.total += 1
    if (p.predictedResult === p.actualResult) sb.correct += 1
    sb.logLossSum += -Math.log(Math.max(pTrue, EPS))

    const ob = byOutcome[p.actualResult]
    ob.total += 1
    if (p.predictedResult === p.actualResult) ob.correct += 1
  }

  const accuracyByConfidence: Record<ConfidenceLevel, AccuracyByConfidence> = {
    low: { matches: byConfidence.low.total, accuracy: byConfidence.low.total ? byConfidence.low.correct / byConfidence.low.total : Number.NaN },
    medium: { matches: byConfidence.medium.total, accuracy: byConfidence.medium.total ? byConfidence.medium.correct / byConfidence.medium.total : Number.NaN },
    high: { matches: byConfidence.high.total, accuracy: byConfidence.high.total ? byConfidence.high.correct / byConfidence.high.total : Number.NaN },
  }

  const seasonEntries: Record<string, SeasonStats> = {}
  for (const [season, s] of Object.entries(bySeason)) {
    seasonEntries[season] = {
      matches: s.total,
      accuracy1X2: s.total ? s.correct / s.total : Number.NaN,
      logLoss: s.total ? s.logLossSum / s.total : Number.NaN,
    }
  }

  const outcomeEntries: Record<Result, OutcomeStats> = {
    H: { matches: byOutcome.H.total, accuracy: byOutcome.H.total ? byOutcome.H.correct / byOutcome.H.total : Number.NaN },
    D: { matches: byOutcome.D.total, accuracy: byOutcome.D.total ? byOutcome.D.correct / byOutcome.D.total : Number.NaN },
    A: { matches: byOutcome.A.total, accuracy: byOutcome.A.total ? byOutcome.A.correct / byOutcome.A.total : Number.NaN },
  }

  return {
    matchCount: n,
    accuracy1X2: n ? correct1X2 / n : Number.NaN,
    exactScoreAccuracy: n ? exact / n : Number.NaN,
    homeGoalsMAE: n ? safeMean(homeErrors) : Number.NaN,
    awayGoalsMAE: n ? safeMean(awayErrors) : Number.NaN,
    totalGoalsMAE: n ? safeMean(totalErrors) : Number.NaN,
    bothWithinOneGoal: n ? withinOne / n : Number.NaN,
    brierScore: n ? safeMean(briers) : Number.NaN,
    logLoss: n ? safeMean(logLosses) : Number.NaN,
    averageConfidenceScore: n ? safeMean(predictions.map((p) => p.confidenceScore)) : Number.NaN,
    accuracyByConfidence,
    bySeason: seasonEntries,
    byOutcome: outcomeEntries,
  }
}

export interface CalibrationBucket {
  outcome: Result
  bucketIndex: number
  /** Inclusive lower bound of the probability bin. */
  lower: number
  /** Exclusive upper bound of the probability bin. */
  upper: number
  predictions: number
  /** Mean predicted probability for this outcome within the bin (0 if empty). */
  avgPredicted: number
  /** Observed frequency of the outcome within the bin (0 if empty). */
  observed: number
}

/**
 * Per-outcome reliability table: for each outcome, bucket predicted probability
 * into `bins` equal-width bins over [0, 1] and compare the average predicted
 * probability with the observed outcome frequency. Empty bins are kept (with
 * zero counts) so the bucket count is deterministic: 3 × `bins`.
 */
export function calibrationBuckets(predictions: MatchPrediction[], bins = 10): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = []
  for (const outcome of OUTCOMES) {
    const sums = new Array<{ count: number; predSum: number; obsSum: number }>(bins)
    for (let i = 0; i < bins; i++) sums[i] = { count: 0, predSum: 0, obsSum: 0 }

    for (const p of predictions) {
      const prob = probabilityFor(p.probabilities, outcome)
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(prob * bins)))
      const cell = sums[idx]
      cell.count += 1
      cell.predSum += prob
      if (p.actualResult === outcome) cell.obsSum += 1
    }

    for (let i = 0; i < bins; i++) {
      const { count, predSum, obsSum } = sums[i]
      buckets.push({
        outcome,
        bucketIndex: i,
        lower: i / bins,
        upper: (i + 1) / bins,
        predictions: count,
        avgPredicted: count ? predSum / count : 0,
        observed: count ? obsSum / count : 0,
      })
    }
  }
  return buckets
}

/** Compact saved form (for the optional backtest-predictions.json). */
export function toSavedPrediction(p: MatchPrediction) {
  return {
    matchId: p.matchId,
    season: p.season,
    date: p.date,
    homeSlug: p.homeSlug,
    awaySlug: p.awaySlug,
    actualHomeGoals: p.actualHomeGoals,
    actualAwayGoals: p.actualAwayGoals,
    actualResult: p.actualResult,
    probabilities: p.probabilities,
    predictedResult: p.predictedResult,
    predictedScoreline: p.predictedScoreline,
    confidence: p.confidence,
    confidenceScore: p.confidenceScore,
    lambdaHome: p.lambdaHome,
    lambdaAway: p.lambdaAway,
  }
}
