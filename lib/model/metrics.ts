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

/* ---------------------- draw-specific metrics ---------------------- */

/** Draw-focused diagnostics (v1.1). */
export interface DrawMetrics {
  actualDrawCount: number
  predictedDrawCount: number
  /** Of predicted draws, the fraction that were actually draws. */
  drawPrecision: number
  /** Of actual draws, the fraction the model predicted as draws. */
  drawRecall: number
  drawF1: number
  /** Binary Brier score for the draw outcome (lower is better). */
  drawBrier: number
  /** Mean predicted draw probability across all matches. */
  avgPredictedDrawProbability: number
  /** Mean predicted draw probability over actual draws. */
  avgDrawProbOnActualDraws: number
  /** Mean predicted draw probability over non-draws. */
  avgDrawProbOnNonDraws: number
  exactScoreAccuracyOnDraws: number
  exactScoreAccuracyOnNonDraws: number
}

function isExact(p: MatchPrediction): boolean {
  return p.predictedScoreline.home === p.actualHomeGoals && p.predictedScoreline.away === p.actualAwayGoals
}

/** Compute the draw-specific diagnostics for a set of predictions. */
export function computeDrawMetrics(predictions: MatchPrediction[]): DrawMetrics {
  const n = predictions.length
  let predictedDraws = 0
  let actualDraws = 0
  let truePositiveDraws = 0
  let drawBrierSum = 0
  let drawProbSum = 0
  let drawProbOnDrawsSum = 0
  let drawProbOnNonDrawsSum = 0
  let nonDraws = 0
  let exactOnDraws = 0
  let exactOnNonDraws = 0

  for (const p of predictions) {
    const isActualDraw = p.actualResult === "D"
    const isPredictedDraw = p.predictedResult === "D"
    const d = p.probabilities.draw

    drawProbSum += d
    drawBrierSum += (d - (isActualDraw ? 1 : 0)) ** 2

    if (isPredictedDraw) predictedDraws++
    if (isActualDraw) {
      actualDraws++
      drawProbOnDrawsSum += d
      if (isPredictedDraw) truePositiveDraws++
      if (isExact(p)) exactOnDraws++
    } else {
      nonDraws++
      drawProbOnNonDrawsSum += d
      if (isExact(p)) exactOnNonDraws++
    }
  }

  const precision = predictedDraws > 0 ? truePositiveDraws / predictedDraws : Number.NaN
  const recall = actualDraws > 0 ? truePositiveDraws / actualDraws : Number.NaN
  const f1 =
    Number.isFinite(precision) && Number.isFinite(recall) && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : Number.NaN

  return {
    actualDrawCount: actualDraws,
    predictedDrawCount: predictedDraws,
    drawPrecision: precision,
    drawRecall: recall,
    drawF1: f1,
    drawBrier: n ? drawBrierSum / n : Number.NaN,
    avgPredictedDrawProbability: n ? drawProbSum / n : Number.NaN,
    avgDrawProbOnActualDraws: actualDraws ? drawProbOnDrawsSum / actualDraws : Number.NaN,
    avgDrawProbOnNonDraws: nonDraws ? drawProbOnNonDrawsSum / nonDraws : Number.NaN,
    exactScoreAccuracyOnDraws: actualDraws ? exactOnDraws / actualDraws : Number.NaN,
    exactScoreAccuracyOnNonDraws: nonDraws ? exactOnNonDraws / nonDraws : Number.NaN,
  }
}

/* ---------------------- 1X2 confusion matrix ---------------------- */

/** `matrix[predicted][actual]` = count. Rows/columns are H, D, A. */
export type ConfusionMatrix = Record<Result, Record<Result, number>>

export function computeConfusionMatrix(predictions: MatchPrediction[]): ConfusionMatrix {
  const m: ConfusionMatrix = {
    H: { H: 0, D: 0, A: 0 },
    D: { H: 0, D: 0, A: 0 },
    A: { H: 0, D: 0, A: 0 },
  }
  for (const p of predictions) m[p.predictedResult][p.actualResult]++
  return m
}

/* ---------------------- outcome distributions ---------------------- */

export interface OutcomeDistributionEntry {
  count: number
  fraction: number
}

function distribution(predictions: MatchPrediction[], which: "predictedResult" | "actualResult"): Record<Result, OutcomeDistributionEntry> {
  const n = predictions.length
  const counts: Record<Result, number> = { H: 0, D: 0, A: 0 }
  for (const p of predictions) counts[p[which]]++
  const out = {} as Record<Result, OutcomeDistributionEntry>
  for (const o of OUTCOMES) {
    out[o] = { count: counts[o], fraction: n ? counts[o] / n : Number.NaN }
  }
  return out
}

export function predictedOutcomeDistribution(predictions: MatchPrediction[]): Record<Result, OutcomeDistributionEntry> {
  return distribution(predictions, "predictedResult")
}

export function actualOutcomeDistribution(predictions: MatchPrediction[]): Record<Result, OutcomeDistributionEntry> {
  return distribution(predictions, "actualResult")
}

/* ---------------------- predicted scoreline distribution ---------------------- */

export interface ScorelineCount {
  home: number
  away: number
  count: number
}

/** Most common predicted scorelines, highest count first (top `topN`). */
export function scorelineDistribution(predictions: MatchPrediction[], topN = 10): ScorelineCount[] {
  const map = new Map<string, ScorelineCount>()
  for (const p of predictions) {
    const key = `${p.predictedScoreline.home}-${p.predictedScoreline.away}`
    const entry = map.get(key)
    if (entry) entry.count++
    else map.set(key, { home: p.predictedScoreline.home, away: p.predictedScoreline.away, count: 1 })
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.home - b.home || a.away - b.away).slice(0, topN)
}

/* ---------------------- predicted scoreline quality (v1.1 §十四) ---------------------- */

/** Distribution + point-estimate quality of the predicted scorelines. */
export interface ScorelineQuality {
  /** Most common predicted scorelines, highest count first. */
  distribution: ScorelineCount[]
  /** Number of distinct predicted scorelines. */
  distinctScorelineCount: number
  /** Fraction of predictions whose top scoreline is the given draw scoreline. */
  drawScorelineFractions: Record<"0-0" | "1-1" | "2-2", number>
  /** Fraction of predictions whose top scoreline is the given one-goal scoreline. */
  oneGoalScorelineFractions: Record<"1-0" | "0-1", number>
  /** Mean predicted home goals (λ_home) across all predictions. */
  avgPredictedHomeGoals: number
  /** Mean predicted away goals (λ_away) across all predictions. */
  avgPredictedAwayGoals: number
  /** Mean actual home goals. */
  avgActualHomeGoals: number
  /** Mean actual away goals. */
  avgActualAwayGoals: number
  /** avgPredicted total goals − avgActual total goals (positive = over-prediction). */
  totalGoalBias: number
  homeGoalBias: number
  awayGoalBias: number
  /** Fraction of predictions whose top scoreline is 1-1 (collapse signal). */
  oneOneFraction: number
}

const DRAW_SCORELINES = ["0-0", "1-1", "2-2"] as const
const ONE_GOAL_SCORELINES = ["1-0", "0-1"] as const

/** Predicted-scoreline diagnostics beyond the single exact-score hit rate. */
export function computeScorelineQuality(predictions: MatchPrediction[], topN = 10): ScorelineQuality {
  const n = predictions.length

  const map = new Map<string, number>()
  let predHomeSum = 0
  let predAwaySum = 0
  let actHomeSum = 0
  let actAwaySum = 0

  for (const p of predictions) {
    const key = `${p.predictedScoreline.home}-${p.predictedScoreline.away}`
    map.set(key, (map.get(key) ?? 0) + 1)
    predHomeSum += p.lambdaHome
    predAwaySum += p.lambdaAway
    actHomeSum += p.actualHomeGoals
    actAwaySum += p.actualAwayGoals
  }

  const distribution = [...map.entries()]
    .map(([key, count]) => {
      const [home, away] = key.split("-").map(Number)
      return { home, away, count }
    })
    .sort((a, b) => b.count - a.count || a.home - b.home || a.away - b.away)
    .slice(0, topN)

  const frac = (scoreline: string): number => (n ? (map.get(scoreline) ?? 0) / n : Number.NaN)

  const drawScorelineFractions = {
    "0-0": frac("0-0"),
    "1-1": frac("1-1"),
    "2-2": frac("2-2"),
  } as Record<"0-0" | "1-1" | "2-2", number>
  const oneGoalScorelineFractions = {
    "1-0": frac("1-0"),
    "0-1": frac("0-1"),
  } as Record<"1-0" | "0-1", number>

  const avgPredictedHomeGoals = n ? predHomeSum / n : Number.NaN
  const avgPredictedAwayGoals = n ? predAwaySum / n : Number.NaN
  const avgActualHomeGoals = n ? actHomeSum / n : Number.NaN
  const avgActualAwayGoals = n ? actAwaySum / n : Number.NaN

  return {
    distribution,
    distinctScorelineCount: map.size,
    drawScorelineFractions,
    oneGoalScorelineFractions,
    avgPredictedHomeGoals,
    avgPredictedAwayGoals,
    avgActualHomeGoals,
    avgActualAwayGoals,
    totalGoalBias: avgPredictedHomeGoals + avgPredictedAwayGoals - (avgActualHomeGoals + avgActualAwayGoals),
    homeGoalBias: avgPredictedHomeGoals - avgActualHomeGoals,
    awayGoalBias: avgPredictedAwayGoals - avgActualAwayGoals,
    oneOneFraction: frac("1-1"),
  }
}

/* ---------------------- confidence breakdown ---------------------- */

export interface ConfidenceBreakdown {
  count: number
  accuracy: number
  brier: number
  logLoss: number
}

/** Per-level accuracy, Brier, and log loss (v1.1 re-validation). */
export function computeConfidenceBreakdown(predictions: MatchPrediction[]): Record<ConfidenceLevel, ConfidenceBreakdown> {
  const acc: Record<ConfidenceLevel, { count: number; correct: number; brierSum: number; logLossSum: number }> = {
    low: { count: 0, correct: 0, brierSum: 0, logLossSum: 0 },
    medium: { count: 0, correct: 0, brierSum: 0, logLossSum: 0 },
    high: { count: 0, correct: 0, brierSum: 0, logLossSum: 0 },
  }
  for (const p of predictions) {
    const c = acc[p.confidence]
    c.count++
    if (p.predictedResult === p.actualResult) c.correct++
    const y = { H: 0, D: 0, A: 0 }
    y[p.actualResult] = 1
    c.brierSum += (p.probabilities.home - y.H) ** 2 + (p.probabilities.draw - y.D) ** 2 + (p.probabilities.away - y.A) ** 2
    c.logLossSum += -Math.log(Math.max(probabilityFor(p.probabilities, p.actualResult), EPS))
  }
  const out = {} as Record<ConfidenceLevel, ConfidenceBreakdown>
  for (const level of ["low", "medium", "high"] as const) {
    const c = acc[level]
    out[level] = {
      count: c.count,
      accuracy: c.count ? c.correct / c.count : Number.NaN,
      brier: c.count ? c.brierSum / c.count : Number.NaN,
      logLoss: c.count ? c.logLossSum / c.count : Number.NaN,
    }
  }
  return out
}
