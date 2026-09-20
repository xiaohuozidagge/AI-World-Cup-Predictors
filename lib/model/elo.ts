/**
 * Pure Elo rating functions. All parameters come from the config; the home
 * advantage is added for prediction only and never written into a base rating.
 */

import type { ModelConfig } from "./config"

/** Expected score for the home team from raw rating difference (no home boost). */
export function expectedHomeScore(homeRating: number, awayRating: number): number {
  return 1 / (1 + Math.pow(10, -(homeRating - awayRating) / 400))
}

/** Rating difference used for prediction (includes home advantage). */
export function predictionRatingDiff(homeRating: number, awayRating: number, config: ModelConfig): number {
  return homeRating + config.elo.homeAdvantage - awayRating
}

/**
 * K multiplier for a decided match: a win by more than one goal scales K up
 * (bounded), a draw uses the base K. `goalDiff` is the home-relative margin.
 */
function kMultiplier(goalDiff: number, config: ModelConfig): number {
  const margin = Math.abs(goalDiff)
  if (margin <= 1) return 1
  return Math.min(1 + config.elo.goalDiffFactor * (margin - 1), 2.5)
}

/**
 * Update two teams' Elo ratings from a finished match result. Mutates `elo` in
 * place (ratings are a plain record the backtest owns). The home advantage is
 * NOT used here — only the raw rating gap affects the update.
 */
export function updateEloAfterMatch(
  elo: Record<string, number>,
  homeSlug: string,
  awaySlug: string,
  homeGoals: number,
  awayGoals: number,
  config: ModelConfig,
): void {
  const homeRating = elo[homeSlug] ?? config.elo.initialRating
  const awayRating = elo[awaySlug] ?? config.elo.initialRating

  const expected = expectedHomeScore(homeRating, awayRating)
  const actual = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5
  const k = config.elo.kFactor * kMultiplier(homeGoals - awayGoals, config)

  const delta = k * (actual - expected)
  elo[homeSlug] = homeRating + delta
  elo[awaySlug] = awayRating - delta
}

/** Pull every rating toward the league mean at a season boundary. */
export function regressEloToMean(
  elo: Record<string, number>,
  config: ModelConfig,
): void {
  const target = config.elo.initialRating
  const f = config.elo.seasonRegression
  for (const slug of Object.keys(elo)) {
    elo[slug] = elo[slug] + (target - elo[slug]) * f
  }
}

/** Initial (or fallback) Elo for a team with no rating yet. */
export function initialElo(config: ModelConfig): number {
  return config.elo.initialRating
}
