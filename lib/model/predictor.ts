/**
 * Prediction orchestration: Elo → attack/defense strength → expected goals →
 * Poisson score matrix → 1X2 probabilities, most-likely scoreline, confidence,
 * and reasons. Pure and deterministic; reads the model state, never the clock.
 */

import type { ModelConfig } from "./config"
import { calibrationOf } from "./config"
import { argmaxOneX2, buildScoreMatrix, readScoreMatrix, type ScoreMatrix } from "./poisson"
import { expectedHomeScore, predictionRatingDiff } from "./elo"
import { teamStrengthView } from "./team-strength"
import { generateReasons } from "./reasons"
import { applyDrawTarget, predictDrawProbability } from "./draw-model"
import { extractFeatureVector, standardizeOne, type DrawRuntime } from "./features"
import type {
  ConfidenceLevel,
  CoverageTier,
  MatchPrediction,
  ModelMatch,
  ModelState,
  OneX2Probabilities,
  Result,
  TeamStrengthView,
} from "./types"

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

const LEVEL_RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 }

function minLevel(a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b
}

/** League average home/away goals from the current (decayed) aggregates. */
export function leagueAverages(
  league: ModelState["league"],
  config: ModelConfig,
): { home: number; away: number } {
  const home = league.weight > 0 ? league.homeGoalsWeight / league.weight : config.lambda.leagueHomeGoals
  const away = league.weight > 0 ? league.awayGoalsWeight / league.weight : config.lambda.leagueAwayGoals
  return { home, away }
}

/** Normalized Shannon entropy of a 1X2 distribution, in [0, 1]. */
export function normalizedEntropy(p: OneX2Probabilities): number {
  const H = -(p.home * log2Safe(p.home) + p.draw * log2Safe(p.draw) + p.away * log2Safe(p.away))
  return H / Math.log2(3)
}

function log2Safe(x: number): number {
  return x > 0 ? Math.log2(x) : 0
}

/** Map raw signals to a confidence level, capped by the weaker coverage tier. */
export function computeConfidence(
  probabilities: OneX2Probabilities,
  homeTier: CoverageTier,
  awayTier: CoverageTier,
  homeObserved: number,
  awayObserved: number,
  config: ModelConfig,
): { score: number; level: ConfidenceLevel } {
  const w = config.confidence.weights
  const pMax = Math.max(probabilities.home, probabilities.draw, probabilities.away)
  const pSecond = [probabilities.home, probabilities.draw, probabilities.away].sort((a, b) => b - a)[1]
  const margin = pMax - pSecond
  const entropy = normalizedEntropy(probabilities)

  const sample = clamp(Math.min(homeObserved, awayObserved) / 60, 0, 1)

  const score =
    w.pMax * pMax +
    w.entropy * (1 - entropy) +
    w.margin * margin +
    w.sample * sample

  const { medium, high } = config.confidence.thresholds
  const raw: ConfidenceLevel = score >= high ? "high" : score >= medium ? "medium" : "low"

  const cap = minLevel(
    config.confidence.capByTier[homeTier],
    config.confidence.capByTier[awayTier],
  )
  const level = minLevel(raw, cap)

  return { score, level }
}

/** Everything needed to predict one match, before any draw-model adjustment. */
export interface MatchContext {
  eloHome: number
  eloAway: number
  eloDiff: number
  rawEloDiff: number
  homeStrength: TeamStrengthView
  awayStrength: TeamStrengthView
  league: { home: number; away: number }
  lambdaHome: number
  lambdaAway: number
  baseMatrix: ScoreMatrix
}

/**
 * Compute the v1 core of a prediction — Elo, strength, expected goals, and the
 * base (uncorrected) score matrix — for one match from the current model state.
 * Shared by `predictMatch` and the draw-model training walker so both see the
 * identical pre-match context.
 */
export function computeMatchContext(match: ModelMatch, state: ModelState, config: ModelConfig): MatchContext {
  const eloHome = state.elo[match.homeSlug] ?? config.elo.initialRating
  const eloAway = state.elo[match.awaySlug] ?? config.elo.initialRating

  const eloDiff = predictionRatingDiff(eloHome, eloAway, config)
  const rawEloDiff = eloHome - eloAway

  const homeStrength = teamStrengthView(state.strength, state.league, match.homeSlug, config)
  const awayStrength = teamStrengthView(state.strength, state.league, match.awaySlug, config)
  const league = leagueAverages(state.league, config)

  const clampedElo = clamp(eloDiff, -config.lambda.maxEloDiff, config.lambda.maxEloDiff)
  const eloHomeFactor = Math.exp(clampedElo * config.lambda.eloToLambda)
  const eloAwayFactor = Math.exp(-clampedElo * config.lambda.eloToLambda)

  const goalScale = calibrationOf(config).goalScale
  const lambdaHome = clamp(
    league.home * homeStrength.homeAttack * awayStrength.awayDefense * eloHomeFactor * goalScale,
    config.lambda.minLambda,
    config.lambda.maxLambda,
  )
  const lambdaAway = clamp(
    league.away * awayStrength.awayAttack * homeStrength.homeDefense * eloAwayFactor * goalScale,
    config.lambda.minLambda,
    config.lambda.maxLambda,
  )

  const baseMatrix = buildScoreMatrix(lambdaHome, lambdaAway, config)

  return {
    eloHome,
    eloAway,
    eloDiff,
    rawEloDiff,
    homeStrength,
    awayStrength,
    league,
    lambdaHome,
    lambdaAway,
    baseMatrix,
  }
}

/** Produce a full prediction for one match from the current model state. */
export function predictMatch(match: ModelMatch, state: ModelState, config: ModelConfig, draw?: DrawRuntime): MatchPrediction {
  const ctx = computeMatchContext(match, state, config)

  let matrix = ctx.baseMatrix
  if (draw) {
    const rawFeatures = extractFeatureVector(
      {
        eloHome: ctx.eloHome,
        eloAway: ctx.eloAway,
        lambdaHome: ctx.lambdaHome,
        lambdaAway: ctx.lambdaAway,
        baseDrawProbability: ctx.baseMatrix.oneX2.draw,
        homeCoverage: ctx.homeStrength.matchesObserved,
        awayCoverage: ctx.awayStrength.matchesObserved,
        homeState: draw.featureState.teams[match.homeSlug],
        awayState: draw.featureState.teams[match.awaySlug],
        noPriorSeason: draw.promotedBySeason[match.season] ?? new Set<string>(),
        homeSlug: match.homeSlug,
        awaySlug: match.awaySlug,
      },
      draw.config.featureSet,
    )
    const standardized = standardizeOne(rawFeatures, {
      means: draw.config.featureMeans,
      stdDevs: draw.config.featureStdDevs,
    })
    const qDraw = predictDrawProbability(standardized, draw.config)
    const adjusted = applyDrawTarget(ctx.baseMatrix.matrix, qDraw)
    matrix = readScoreMatrix(adjusted, ctx.baseMatrix.coverageMass)
  }

  const probabilities = matrix.oneX2
  const predictedResult: Result = argmaxOneX2(probabilities)

  const confidence = computeConfidence(
    probabilities,
    ctx.homeStrength.tier,
    ctx.awayStrength.tier,
    ctx.homeStrength.matchesObserved,
    ctx.awayStrength.matchesObserved,
    config,
  )

  const reasons = generateReasons(
    {
      homeSlug: match.homeSlug,
      awaySlug: match.awaySlug,
      eloHome: ctx.eloHome,
      eloAway: ctx.eloAway,
      rawEloDiff: ctx.rawEloDiff,
      eloDiff: ctx.eloDiff,
      homeAdvantage: config.elo.homeAdvantage,
      homeStrength: ctx.homeStrength,
      awayStrength: ctx.awayStrength,
      leagueHomeAvg: ctx.league.home,
      leagueAwayAvg: ctx.league.away,
      lambdaHome: ctx.lambdaHome,
      lambdaAway: ctx.lambdaAway,
      probabilities,
      predictedResult,
    },
    config,
  )

  const actualResult: Result = match.homeGoals > match.awayGoals ? "H" : match.homeGoals < match.awayGoals ? "A" : "D"

  return {
    matchId: match.id,
    season: match.season,
    date: match.date,
    homeSlug: match.homeSlug,
    awaySlug: match.awaySlug,
    actualHomeGoals: match.homeGoals,
    actualAwayGoals: match.awayGoals,
    actualResult,
    lambdaHome: ctx.lambdaHome,
    lambdaAway: ctx.lambdaAway,
    probabilities,
    predictedResult,
    predictedScoreline: matrix.topScoreline,
    topScorelines: matrix.topScorelines,
    confidence: confidence.level,
    confidenceScore: confidence.score,
    reasons,
    eloHome: ctx.eloHome,
    eloAway: ctx.eloAway,
    eloDiff: ctx.eloDiff,
    homeStrength: ctx.homeStrength,
    awayStrength: ctx.awayStrength,
  }
}

/** Re-exported for the baselines (Elo-only uses the same expected-score). */
export { expectedHomeScore }
