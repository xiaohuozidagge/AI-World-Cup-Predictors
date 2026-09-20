/**
 * Chronological, date-batched backtest engine plus three reference baselines
 * (Always Home Win, League-Average Poisson, Elo-Only). The engine predicts
 * every match of a date using the state BEFORE any same-day result is absorbed,
 * then updates — so no result ever informs a prediction issued the same day.
 */

import type { ModelConfig } from "./config"
import { dateToDayIndex } from "./dates"
import { regressEloToMean, updateEloAfterMatch } from "./elo"
import { decayState, EMPTY_LEAGUE, updateStrengthAfterMatch } from "./team-strength"
import { predictionRatingDiff } from "./elo"
import { argmaxOneX2, buildScoreMatrix } from "./poisson"
import { predictMatch } from "./predictor"
import type { MatchPrediction, ModelMatch, ModelState, TeamStrengthView } from "./types"

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

export function initialModelState(): ModelState {
  return { elo: {}, strength: {}, league: { ...EMPTY_LEAGUE }, dayIndex: 0, season: null }
}

/** Sort defensively and group matches by date (stable within a date). */
export function groupMatchesByDate(matches: ModelMatch[]): Array<[string, ModelMatch[]]> {
  const sorted = [...matches].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
  const map = new Map<string, ModelMatch[]>()
  for (const m of sorted) {
    const arr = map.get(m.date)
    if (arr) arr.push(m)
    else map.set(m.date, [m])
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

export interface BacktestOptions {
  /** Seasons whose predictions are recorded; all earlier seasons warm the state. */
  evaluateSeasons: string[]
}

/**
 * Run the full model chronologically. Seasons not in `evaluateSeasons` still
 * update Elo/strength (burn-in + tuning warm-up) but contribute no predictions.
 */
export function runBacktest(matches: ModelMatch[], config: ModelConfig, options: BacktestOptions): MatchPrediction[] {
  const evaluate = new Set(options.evaluateSeasons)
  const state = initialModelState()
  const predictions: MatchPrediction[] = []

  for (const [date, group] of groupMatchesByDate(matches)) {
    const dayIndex = dateToDayIndex(date)
    const days = dayIndex - state.dayIndex
    if (days > 0) {
      const factor = Math.exp((-Math.LN2 * days) / config.strength.halfLifeDays)
      decayState(state.strength, state.league, factor)
    }
    state.dayIndex = dayIndex

    const season = group[0].season
    if (state.season !== null && state.season !== season) {
      regressEloToMean(state.elo, config)
    }
    state.season = season

    for (const m of group) {
      if (evaluate.has(m.season)) predictions.push(predictMatch(m, state, config))
    }
    for (const m of group) {
      updateEloAfterMatch(state.elo, m.homeSlug, m.awaySlug, m.homeGoals, m.awayGoals, config)
      updateStrengthAfterMatch(state.strength, state.league, m.homeSlug, m.awaySlug, m.homeGoals, m.awayGoals)
    }
  }

  return predictions
}

/* ----------------------------- baselines ----------------------------- */

function leagueGoalAverages(matches: ModelMatch[]): { home: number; away: number } {
  if (matches.length === 0) return { home: 0, away: 0 }
  let h = 0
  let a = 0
  for (const m of matches) {
    h += m.homeGoals
    a += m.awayGoals
  }
  return { home: h / matches.length, away: a / matches.length }
}

const NEUTRAL_VIEW: TeamStrengthView = {
  homeAttack: 1,
  awayAttack: 1,
  homeDefense: 1,
  awayDefense: 1,
  matchesObserved: 0,
  tier: "none",
}

/** Build a full prediction from two lambdas (used by the Poisson baselines). */
function predictionFromLambdas(match: ModelMatch, lambdaHome: number, lambdaAway: number, config: ModelConfig): MatchPrediction {
  const matrix = buildScoreMatrix(lambdaHome, lambdaAway, config)
  const actualResult = match.homeGoals > match.awayGoals ? "H" : match.homeGoals < match.awayGoals ? "A" : "D"
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
    probabilities: matrix.oneX2,
    predictedResult: argmaxOneX2(matrix.oneX2),
    predictedScoreline: matrix.topScoreline,
    topScorelines: matrix.topScorelines,
    confidence: "low",
    confidenceScore: 0,
    reasons: [],
    eloHome: 0,
    eloAway: 0,
    eloDiff: 0,
    homeStrength: NEUTRAL_VIEW,
    awayStrength: NEUTRAL_VIEW,
  }
}

/** Baseline 1: always predict a home win with full confidence. */
export function runBaselineAlwaysHome(matches: ModelMatch[], config: ModelConfig): MatchPrediction[] {
  return matches.map((m) =>
    predictionFromLambdas(
      m,
      config.lambda.leagueHomeGoals,
      config.lambda.leagueAwayGoals,
      config,
    ),
  ).map((p) => ({
    ...p,
    probabilities: { home: 1, draw: 0, away: 0 },
    predictedResult: "H" as const,
  }))
}

/** Baseline 2: a constant Poisson model using league-average home/away goals. */
export function runBaselineLeagueAverage(
  matches: ModelMatch[],
  warmupMatches: ModelMatch[],
  config: ModelConfig,
): MatchPrediction[] {
  const avg = leagueGoalAverages(warmupMatches)
  return matches.map((m) => predictionFromLambdas(m, avg.home, avg.away, config))
}

/** Baseline 3: Elo-rated λ (no attack/defense strength), warmed on prior seasons. */
export function runBaselineEloOnly(
  matches: ModelMatch[],
  warmupMatches: ModelMatch[],
  config: ModelConfig,
  options: BacktestOptions,
): MatchPrediction[] {
  const evaluate = new Set(options.evaluateSeasons)
  const avg = leagueGoalAverages(warmupMatches)
  const elo: Record<string, number> = {}
  let season: string | null = null
  const predictions: MatchPrediction[] = []

  for (const [, group] of groupMatchesByDate(matches)) {
    if (season !== null && season !== group[0].season) regressEloToMean(elo, config)
    season = group[0].season

    for (const m of group) {
      if (!evaluate.has(m.season)) continue
      const eloHome = elo[m.homeSlug] ?? config.elo.initialRating
      const eloAway = elo[m.awaySlug] ?? config.elo.initialRating
      const diff = predictionRatingDiff(eloHome, eloAway, config)
      const c = clamp(diff, -config.lambda.maxEloDiff, config.lambda.maxEloDiff)
      const factor = Math.exp(c * config.lambda.eloToLambda)
      const lambdaHome = clamp(avg.home * factor, config.lambda.minLambda, config.lambda.maxLambda)
      const lambdaAway = clamp(avg.away / factor, config.lambda.minLambda, config.lambda.maxLambda)
      predictions.push(predictionFromLambdas(m, lambdaHome, lambdaAway, config))
    }
    for (const m of group) {
      updateEloAfterMatch(elo, m.homeSlug, m.awaySlug, m.homeGoals, m.awayGoals, config)
    }
  }

  return predictions
}
