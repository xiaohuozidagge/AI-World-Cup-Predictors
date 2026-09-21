/**
 * Pre-match feature extraction for the v1.2 draw model.
 *
 * Every feature is a pure function of information available strictly BEFORE the
 * match kicks off: the evolving v1 model state (Elo / expected goals / base
 * draw probability / coverage), each team's own prior matches (recent-5 form and
 * season-to-date aggregates), and a season-membership flag (promoted / no prior
 * season data). No feature ever reads the current match's result, any same-day
 * result, or any future result.
 *
 * Three feature groups are pre-registered (§六):
 *   A — base (Elo gap, λ total/gap, base draw probability, coverage): 6 features
 *   B — A + recent-5 form: 15 features
 *   C — B + season-to-date + flags: 23 features
 *
 * Teams with no history use explicit league-neutral constants, never future
 * means. Standardization statistics are computed from training data only.
 * Pure and deterministic — no clock, no randomness.
 */

import type { DrawModelConfig, FeatureSet, ModelMatch } from "./types"

/** Number of matches kept in the recent-form window. */
export const RECENT_WINDOW = 5

/**
 * League-neutral defaults for a team with no usable history. These are fixed
 * constants, not fitted to any data, so they carry zero information about any
 * outcome (and therefore cannot leak).
 */
export const NEUTRAL_DRAW_RATE = 0.25
export const NEUTRAL_TOTAL_GOALS = 2.7
export const NEUTRAL_ABS_GOAL_DIFF = 1.3
export const NEUTRAL_GOALS_FOR = 1.35
export const NEUTRAL_GOALS_AGAINST = 1.35

/** A single prior match from one team's perspective. */
export interface TeamFeatureEntry {
  goalsFor: number
  goalsAgainst: number
  date: string
}

/** Rolling recent-form window plus season-to-date aggregates for one team. */
export interface TeamFeatureState {
  /** Most recent first, capped at RECENT_WINDOW. */
  recent: TeamFeatureEntry[]
  seasonFor: number
  seasonAgainst: number
  seasonMatches: number
}

/** The evolving pre-match feature state maintained alongside the v1 state. */
export interface FeatureState {
  teams: Record<string, TeamFeatureState>
  currentSeason: string | null
}

/** Runtime bundle handed to the predictor when a draw model is active. */
export interface DrawRuntime {
  config: DrawModelConfig
  featureState: FeatureState
  /** season → set of teams with no matches in any earlier season (promoted). */
  promotedBySeason: Record<string, Set<string>>
}

/** Canonical ordered feature names; each group is a prefix of this list. */
export const ALL_FEATURE_NAMES: readonly string[] = [
  "absEloDifference",
  "lambdaTotal",
  "absLambdaDifference",
  "baseDrawProbability",
  "homeDataCoverage",
  "awayDataCoverage",
  "homeRecentDrawRate",
  "awayRecentDrawRate",
  "recentDrawRateMean",
  "homeRecentAvgTotalGoals",
  "awayRecentAvgTotalGoals",
  "recentAvgTotalGoalsMean",
  "homeRecentAvgAbsGoalDiff",
  "awayRecentAvgAbsGoalDiff",
  "recentAvgAbsGoalDiffMean",
  "homeSeasonAvgGoalsFor",
  "homeSeasonAvgGoalsAgainst",
  "awaySeasonAvgGoalsFor",
  "awaySeasonAvgGoalsAgainst",
  "goalScoringDifference",
  "goalConcedingDifference",
  "insufficientSampleFlag",
  "noPriorSeasonFlag",
] as const

export function featureSetSize(featureSet: FeatureSet): number {
  return featureSet === "A" ? 6 : featureSet === "B" ? 15 : 23
}

export function featureNamesFor(featureSet: FeatureSet): string[] {
  return ALL_FEATURE_NAMES.slice(0, featureSetSize(featureSet)).map((n) => n)
}

export function initFeatureState(): FeatureState {
  return { teams: {}, currentSeason: null }
}

/**
 * Record a finished match into the feature state from each team's perspective.
 * Called only AFTER every same-day prediction is issued, so a match's own result
 * (and any same-day result) can never reach its own features.
 */
export function recordMatchToFeatureState(state: FeatureState, match: ModelMatch): void {
  if (state.currentSeason !== match.season) {
    if (state.currentSeason !== null) {
      for (const t of Object.values(state.teams)) {
        t.seasonFor = 0
        t.seasonAgainst = 0
        t.seasonMatches = 0
      }
    }
    state.currentSeason = match.season
  }

  const home = state.teams[match.homeSlug] ?? (state.teams[match.homeSlug] = emptyTeamFeatureState())
  home.recent.unshift({ goalsFor: match.homeGoals, goalsAgainst: match.awayGoals, date: match.date })
  home.recent = home.recent.slice(0, RECENT_WINDOW)
  home.seasonFor += match.homeGoals
  home.seasonAgainst += match.awayGoals
  home.seasonMatches += 1

  const away = state.teams[match.awaySlug] ?? (state.teams[match.awaySlug] = emptyTeamFeatureState())
  away.recent.unshift({ goalsFor: match.awayGoals, goalsAgainst: match.homeGoals, date: match.date })
  away.recent = away.recent.slice(0, RECENT_WINDOW)
  away.seasonFor += match.awayGoals
  away.seasonAgainst += match.homeGoals
  away.seasonMatches += 1
}

function emptyTeamFeatureState(): TeamFeatureState {
  return { recent: [], seasonFor: 0, seasonAgainst: 0, seasonMatches: 0 }
}

/**
 * For each season, the set of teams with no matches in any earlier season in the
 * given list — i.e. promoted sides (or, for the first season, every team). This
 * is a pre-season membership fact, not a result, so it is available before the
 * season and leaks nothing.
 */
export function computeNoPriorSeasonLookup(matches: ModelMatch[]): Record<string, Set<string>> {
  const seasons: string[] = []
  const teamsBySeason: Record<string, Set<string>> = {}
  for (const m of matches) {
    let set = teamsBySeason[m.season]
    if (!set) {
      set = new Set()
      teamsBySeason[m.season] = set
      seasons.push(m.season)
    }
    set.add(m.homeSlug)
    set.add(m.awaySlug)
  }
  seasons.sort()

  const prior = new Set<string>()
  const out: Record<string, Set<string>> = {}
  for (const s of seasons) {
    const current = teamsBySeason[s]
    const noPrior = new Set<string>()
    for (const t of current) if (!prior.has(t)) noPrior.add(t)
    out[s] = noPrior
    for (const t of current) prior.add(t)
  }
  return out
}

/** Pre-match inputs needed to compute the raw feature vector. */
export interface DrawFeatureContext {
  eloHome: number
  eloAway: number
  lambdaHome: number
  lambdaAway: number
  baseDrawProbability: number
  homeCoverage: number
  awayCoverage: number
  homeState: TeamFeatureState | undefined
  awayState: TeamFeatureState | undefined
  /** No-prior-season set for the match's season. */
  noPriorSeason: Set<string>
  homeSlug: string
  awaySlug: string
}

interface RecentStats {
  drawRate: number
  avgTotalGoals: number
  avgAbsGoalDiff: number
}

function recentStats(entries: TeamFeatureEntry[]): RecentStats | null {
  if (entries.length === 0) return null
  let draws = 0
  let total = 0
  let absDiff = 0
  for (const e of entries) {
    if (e.goalsFor === e.goalsAgainst) draws++
    total += e.goalsFor + e.goalsAgainst
    absDiff += Math.abs(e.goalsFor - e.goalsAgainst)
  }
  return {
    drawRate: draws / entries.length,
    avgTotalGoals: total / entries.length,
    avgAbsGoalDiff: absDiff / entries.length,
  }
}

function seasonAvgFor(t: TeamFeatureState | undefined): number {
  return t && t.seasonMatches > 0 ? t.seasonFor / t.seasonMatches : NEUTRAL_GOALS_FOR
}

function seasonAvgAgainst(t: TeamFeatureState | undefined): number {
  return t && t.seasonMatches > 0 ? t.seasonAgainst / t.seasonMatches : NEUTRAL_GOALS_AGAINST
}

/** Compute the raw (unstandardized) feature vector for the given feature group. */
export function extractFeatureVector(ctx: DrawFeatureContext, featureSet: FeatureSet): number[] {
  const hs = recentStats(ctx.homeState?.recent ?? [])
  const as = recentStats(ctx.awayState?.recent ?? [])

  const homeRecentDrawRate = hs?.drawRate ?? NEUTRAL_DRAW_RATE
  const awayRecentDrawRate = as?.drawRate ?? NEUTRAL_DRAW_RATE
  const homeRecentAvgTotalGoals = hs?.avgTotalGoals ?? NEUTRAL_TOTAL_GOALS
  const awayRecentAvgTotalGoals = as?.avgTotalGoals ?? NEUTRAL_TOTAL_GOALS
  const homeRecentAvgAbsGoalDiff = hs?.avgAbsGoalDiff ?? NEUTRAL_ABS_GOAL_DIFF
  const awayRecentAvgAbsGoalDiff = as?.avgAbsGoalDiff ?? NEUTRAL_ABS_GOAL_DIFF

  const homeSeasonAvgGoalsFor = seasonAvgFor(ctx.homeState)
  const homeSeasonAvgGoalsAgainst = seasonAvgAgainst(ctx.homeState)
  const awaySeasonAvgGoalsFor = seasonAvgFor(ctx.awayState)
  const awaySeasonAvgGoalsAgainst = seasonAvgAgainst(ctx.awayState)

  const bothHaveEnough = (ctx.homeState?.seasonMatches ?? 0) >= 5 && (ctx.awayState?.seasonMatches ?? 0) >= 5
  const insufficientSampleFlag = bothHaveEnough ? 0 : 1
  const noPriorSeasonFlag = ctx.noPriorSeason.has(ctx.homeSlug) || ctx.noPriorSeason.has(ctx.awaySlug) ? 1 : 0

  const full: number[] = [
    Math.abs(ctx.eloHome - ctx.eloAway),
    ctx.lambdaHome + ctx.lambdaAway,
    Math.abs(ctx.lambdaHome - ctx.lambdaAway),
    ctx.baseDrawProbability,
    ctx.homeCoverage,
    ctx.awayCoverage,
    homeRecentDrawRate,
    awayRecentDrawRate,
    (homeRecentDrawRate + awayRecentDrawRate) / 2,
    homeRecentAvgTotalGoals,
    awayRecentAvgTotalGoals,
    (homeRecentAvgTotalGoals + awayRecentAvgTotalGoals) / 2,
    homeRecentAvgAbsGoalDiff,
    awayRecentAvgAbsGoalDiff,
    (homeRecentAvgAbsGoalDiff + awayRecentAvgAbsGoalDiff) / 2,
    homeSeasonAvgGoalsFor,
    homeSeasonAvgGoalsAgainst,
    awaySeasonAvgGoalsFor,
    awaySeasonAvgGoalsAgainst,
    homeSeasonAvgGoalsFor - awaySeasonAvgGoalsFor,
    homeSeasonAvgGoalsAgainst - awaySeasonAvgGoalsAgainst,
    insufficientSampleFlag,
    noPriorSeasonFlag,
  ]

  return full.slice(0, featureSetSize(featureSet))
}

/** Per-feature standardization statistics. */
export interface StandardizationParams {
  means: number[]
  stdDevs: number[]
}

/**
 * Compute feature mean/std from training rows only. A constant (zero-variance)
 * feature gets std = 1 so z-scoring is a no-op rather than a division by zero.
 */
export function computeStandardization(features: number[][]): StandardizationParams {
  const n = features.length
  const d = features[0]?.length ?? 0
  const means = new Array<number>(d).fill(0)
  for (const row of features) for (let j = 0; j < d; j++) means[j] += row[j]
  for (let j = 0; j < d; j++) means[j] /= Math.max(n, 1)

  const stdDevs = new Array<number>(d).fill(0)
  for (const row of features) for (let j = 0; j < d; j++) stdDevs[j] += (row[j] - means[j]) ** 2
  for (let j = 0; j < d; j++) {
    const variance = n > 0 ? stdDevs[j] / n : 0
    stdDevs[j] = Math.sqrt(variance)
    if (!Number.isFinite(stdDevs[j]) || stdDevs[j] < 1e-12) stdDevs[j] = 1
  }
  return { means, stdDevs }
}

/** Standardize a matrix of raw feature rows using training-time statistics. */
export function standardizeFeatures(features: number[][], p: StandardizationParams): number[][] {
  return features.map((row) => row.map((v, j) => (v - p.means[j]) / p.stdDevs[j]))
}

/** Standardize a single raw feature vector using training-time statistics. */
export function standardizeOne(features: number[], p: StandardizationParams): number[] {
  return features.map((v, j) => (v - p.means[j]) / p.stdDevs[j])
}
