/**
 * Prediction orchestration: Elo → attack/defense strength → expected goals →
 * Poisson score matrix → 1X2 probabilities, most-likely scoreline, confidence,
 * and reasons. Pure and deterministic; reads the model state, never the clock.
 */

import type { ModelConfig } from "./config"
import { argmaxOneX2, buildScoreMatrix } from "./poisson"
import { expectedHomeScore, predictionRatingDiff } from "./elo"
import { teamStrengthView } from "./team-strength"
import { generateReasons } from "./reasons"
import type {
  ConfidenceLevel,
  CoverageTier,
  MatchPrediction,
  ModelMatch,
  ModelState,
  OneX2Probabilities,
  Result,
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

/** Produce a full prediction for one match from the current model state. */
export function predictMatch(match: ModelMatch, state: ModelState, config: ModelConfig): MatchPrediction {
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

  const lambdaHome = clamp(
    league.home * homeStrength.homeAttack * awayStrength.awayDefense * eloHomeFactor,
    config.lambda.minLambda,
    config.lambda.maxLambda,
  )
  const lambdaAway = clamp(
    league.away * awayStrength.awayAttack * homeStrength.homeDefense * eloAwayFactor,
    config.lambda.minLambda,
    config.lambda.maxLambda,
  )

  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, config)
  const probabilities = matrix.oneX2
  const predictedResult: Result = argmaxOneX2(probabilities)

  const confidence = computeConfidence(
    probabilities,
    homeStrength.tier,
    awayStrength.tier,
    homeStrength.matchesObserved,
    awayStrength.matchesObserved,
    config,
  )

  const reasons = generateReasons(
    {
      homeSlug: match.homeSlug,
      awaySlug: match.awaySlug,
      eloHome,
      eloAway,
      rawEloDiff,
      eloDiff,
      homeAdvantage: config.elo.homeAdvantage,
      homeStrength,
      awayStrength,
      leagueHomeAvg: league.home,
      leagueAwayAvg: league.away,
      lambdaHome,
      lambdaAway,
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
    lambdaHome,
    lambdaAway,
    probabilities,
    predictedResult,
    predictedScoreline: matrix.topScoreline,
    topScorelines: matrix.topScorelines,
    confidence: confidence.level,
    confidenceScore: confidence.score,
    reasons,
    eloHome,
    eloAway,
    eloDiff,
    homeStrength,
    awayStrength,
  }
}

/** Re-exported for the baselines (Elo-only uses the same expected-score). */
export { expectedHomeScore }
