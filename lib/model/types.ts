/**
 * Shared types for the Premier League prediction model. Pure types only — no
 * runtime code, no I/O.
 */

export type Result = "H" | "D" | "A"

export type CoverageTier = "strong" | "medium" | "limited" | "none"

export type ConfidenceLevel = "low" | "medium" | "high"

/** A minimal, self-contained match record the model consumes. */
export interface ModelMatch {
  id: string
  season: string
  date: string // "YYYY-MM-DD"
  homeSlug: string
  awaySlug: string
  homeGoals: number
  awayGoals: number
}

/** Rolling (exponentially decayed) strength aggregates for one team. */
export interface TeamStrengthState {
  homeForWeight: number // Σ w · goals scored at home
  homeForCount: number // Σ w (home matches)
  awayForWeight: number
  awayForCount: number
  homeAgainstWeight: number // Σ w · goals conceded at home
  homeAgainstCount: number
  awayAgainstWeight: number
  awayAgainstCount: number
  matchesObserved: number // raw (undecayed) match count, for coverage tier
}

/** Rolling (exponentially decayed) league-wide goal aggregates. */
export interface LeagueState {
  homeGoalsWeight: number
  awayGoalsWeight: number
  weight: number // Σ w over all matches (denominator for both averages)
}

/** The full, evolving model state used by the backtest. */
export interface ModelState {
  elo: Record<string, number>
  strength: Record<string, TeamStrengthState>
  league: LeagueState
  dayIndex: number
  season: string | null
}

/** A team's strength ratios at a point in time, after shrinkage. */
export interface TeamStrengthView {
  homeAttack: number
  awayAttack: number
  homeDefense: number
  awayDefense: number
  matchesObserved: number
  tier: CoverageTier
}

/** A single traceable prediction reason (pure rule output). */
export interface Reason {
  code: string
  text: string
  value: number
  comparisonValue: number
}

/** A probability mass function over 1X2 outcomes. */
export interface OneX2Probabilities {
  home: number
  draw: number
  away: number
}

/** A full model prediction for a single match. */
export interface MatchPrediction {
  matchId: string
  season: string
  date: string
  homeSlug: string
  awaySlug: string
  actualHomeGoals: number
  actualAwayGoals: number
  actualResult: Result
  lambdaHome: number
  lambdaAway: number
  probabilities: OneX2Probabilities
  predictedResult: Result
  predictedScoreline: { home: number; away: number }
  topScorelines: Array<{ home: number; away: number; probability: number }>
  confidence: ConfidenceLevel
  confidenceScore: number
  reasons: Reason[]
  eloHome: number
  eloAway: number
  eloDiff: number
  homeStrength: TeamStrengthView
  awayStrength: TeamStrengthView
}

export interface Scoreline {
  home: number
  away: number
}

/** The three pre-registered draw-model feature groups (v1.2 §六). */
export type FeatureSet = "A" | "B" | "C"

/**
 * A fitted, frozen per-match draw model (L2-regularized logistic regression).
 * All numeric fields are computed from training data only and frozen before any
 * locked validation is run. Feature standardization (`featureMeans` /
 * `featureStdDevs`) is applied in feature-list order; `coefficients` are the
 * regression weights (intercept stored separately). Pure data, no runtime.
 */
export interface DrawModelConfig {
  featureSet: FeatureSet
  /** L2 regularization strength ∈ {0.01, 0.1, 1, 10}. */
  l2: number
  featureNames: string[]
  featureMeans: number[]
  featureStdDevs: number[]
  coefficients: number[]
  intercept: number
}

/** A compact, JSON-serializable prediction saved for debugging only. */
export interface SavedPrediction {
  matchId: string
  season: string
  date: string
  homeSlug: string
  awaySlug: string
  actualHomeGoals: number
  actualAwayGoals: number
  actualResult: Result
  probabilities: OneX2Probabilities
  predictedResult: Result
  predictedScoreline: Scoreline
  confidence: ConfidenceLevel
  confidenceScore: number
  lambdaHome: number
  lambdaAway: number
}
