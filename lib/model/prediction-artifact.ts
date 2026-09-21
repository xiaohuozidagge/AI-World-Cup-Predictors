/**
 * Prediction artifact builder for the static 2026/27 Premier League snapshot.
 *
 * This module turns raw `MatchPrediction` output from the v1 model into the
 * JSON shape written under `data/predictions/premier-league/2026-27/`
 * (`manifest.json`, `predictions.json`, `backtest-report.json`). It is pure and
 * deterministic: no I/O, no clock, no randomness. All model math is reused from
 * the existing v1 modules — this file only orchestrates state transitions and
 * maps predictions into the artifact shape, so it must never re-implement a
 * prediction formula.
 */

import { createHash } from "node:crypto"

import type { ModelConfig } from "./config"
import { dateToDayIndex } from "./dates"
import { regressEloToMean, updateEloAfterMatch } from "./elo"
import { decayState, updateStrengthAfterMatch } from "./team-strength"
import { initialModelState, groupMatchesByDate } from "./backtest"
import { predictMatch } from "./predictor"
import {
  computeConfidenceBreakdown,
  computeConfusionMatrix,
  computeDrawMetrics,
  computeMetrics,
  predictedOutcomeDistribution,
  actualOutcomeDistribution,
  scorelineDistribution,
  type ConfidenceBreakdown,
  type ConfusionMatrix,
  type DrawMetrics,
  type OutcomeDistributionEntry,
  type PredictionMetrics,
  type ScorelineCount,
} from "./metrics"
import type {
  ConfidenceLevel,
  CoverageTier,
  MatchPrediction,
  ModelMatch,
  ModelState,
  OneX2Probabilities,
  Reason,
  Result,
} from "./types"

/* --------------------------- hashing --------------------------- */

/** Deterministic SHA-256 over a sequence of raw byte/string inputs. */
export function sha256Hex(...inputs: Array<string | Buffer>): string {
  const hash = createHash("sha256")
  for (const input of inputs) hash.update(input)
  return hash.digest("hex")
}

/* --------------------------- replay --------------------------- */

export interface ReplayResult {
  /** Predictions for matches whose season is in `evaluateSeasons`. */
  predictions: MatchPrediction[]
  /** The state after every match (evaluated or not) has been absorbed. */
  finalState: ModelState
}

/**
 * Chronological, date-batched replay that returns BOTH the evaluated
 * predictions and the final state. This is the v1/v1.1 state-advancement loop
 * of `runBacktest`, with the final state additionally returned so the 340
 * candidate predictions can be issued from a single frozen state. It refuses a
 * v1.2 draw model (which needs feature state this loop does not maintain).
 *
 * Same-day matches are predicted before any same-day result is absorbed; no
 * result ever informs a prediction issued the same day. State transitions reuse
 * the model's own Elo/strength update functions — this function contains no
 * prediction formula.
 */
export function replayMatches(
  matches: ModelMatch[],
  config: ModelConfig,
  evaluateSeasons: string[],
): ReplayResult {
  if (config.drawModel !== undefined) {
    throw new Error("replayMatches only supports v1/v1.1 configs (no drawModel)")
  }
  const evaluate = new Set(evaluateSeasons)
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

  return { predictions, finalState: state }
}

/** Advance the model state over `matches` without recording predictions. */
export function advanceState(matches: ModelMatch[], config: ModelConfig): ModelState {
  return replayMatches(matches, config, []).finalState
}

/* --------------------------- reasons --------------------------- */

export type ReasonDirection = "home" | "away" | "none" | "neutral"

/** Real pre-match historical coverage counts for the two sides. */
export interface CoverageValue {
  home: number
  away: number
}

export interface PredictionReason {
  code: string
  label: string
  text: string
  value: number | CoverageValue
  comparisonValue: number
  direction: ReasonDirection
  source: string
}

const DIRECTION_BY_CODE: Record<string, ReasonDirection> = {
  ELO_ADVANTAGE_HOME: "home",
  ELO_ADVANTAGE_AWAY: "away",
  HOME_ATTACK: "home",
  AWAY_ATTACK: "away",
  AWAY_DEFENSE_WEAK: "home", // a leaky away defence favours the home attack
  HOME_DEFENSE_WEAK: "away", // a leaky home defence favours the away attack
  EXPECTED_GOALS: "none",
  HOME_ADVANTAGE: "home",
  LIMITED_HISTORY: "none",
}

const LABEL_BY_CODE: Record<string, string> = {
  ELO_ADVANTAGE_HOME: "Elo advantage (home)",
  ELO_ADVANTAGE_AWAY: "Elo advantage (away)",
  HOME_ATTACK: "Home attack",
  AWAY_ATTACK: "Away attack",
  AWAY_DEFENSE_WEAK: "Away defence weak",
  HOME_DEFENSE_WEAK: "Home defence weak",
  EXPECTED_GOALS: "Expected goals",
  HOME_ADVANTAGE: "Home advantage",
  LIMITED_HISTORY: "Limited history",
}

/** Map a model `Reason` into the traceable artifact reason shape. */
export function mapReason(reason: Reason, source: string): PredictionReason {
  return {
    code: reason.code,
    label: LABEL_BY_CODE[reason.code] ?? reason.code,
    text: reason.text,
    value: reason.value,
    comparisonValue: reason.comparisonValue,
    direction: DIRECTION_BY_CODE[reason.code] ?? "none",
    source,
  }
}

/** One full Premier League season, matching the v1 `coverage.limitedMaxMatches`. */
const COVERAGE_FULL_SEASON = 38

/** Below this many reasons a neutral DATA_COVERAGE reason is appended. */
export const MIN_ARTIFACT_REASONS = 3

/**
 * Build a neutral, traceable DATA_COVERAGE reason from real pre-match coverage.
 *
 * This is the ONLY reason added at the artifact layer (never inside the v1
 * model). It is derived purely from each side's pre-match `matchesObserved`
 * count and coverage tier — both computed by the model from the pre-match
 * state, so it cannot read the match's own result. It never expresses a
 * home/draw/away preference and never alters any prediction value.
 */
export function buildCoverageReason(
  homeObserved: number,
  awayObserved: number,
  homeTier: CoverageTier,
  awayTier: CoverageTier,
): PredictionReason {
  const homeSufficient = homeTier !== "limited" && homeTier !== "none"
  const awaySufficient = awayTier !== "limited" && awayTier !== "none"

  let text: string
  if (homeSufficient && awaySufficient) {
    text = `Historical data coverage is sufficient for both sides (home ${homeObserved}, away ${awayObserved} matches).`
  } else if (!homeSufficient && !awaySufficient) {
    text = `Historical data coverage is limited for both sides (home ${homeObserved}, away ${awayObserved} matches), so model uncertainty is higher.`
  } else if (!homeSufficient) {
    text = `Historical data coverage is limited for the home side (${homeObserved} matches; away ${awayObserved}).`
  } else {
    text = `Historical data coverage is limited for the away side (${awayObserved} matches; home ${homeObserved}).`
  }

  return {
    code: "DATA_COVERAGE",
    label: "Historical data coverage",
    text,
    value: { home: homeObserved, away: awayObserved },
    comparisonValue: COVERAGE_FULL_SEASON,
    direction: "neutral",
    source: "prediction-artifact",
  }
}

/* --------------------------- artifact shape --------------------------- */

export type PredictionType = "backtest" | "candidate"
export type PredictionState = "historical_reconstruction" | "unlocked"

export interface ArtifactTeam {
  slug: string
  name: string
  shortName: string | null
}

export interface ArtifactScore {
  home: number
  away: number
}

export interface ArtifactConfidence {
  score: number
  level: ConfidenceLevel
}

export interface PredictionArtifact {
  id: string
  slug: string
  competitionSlug: string
  season: string
  matchweek: number | null
  kickoffUtc: string
  homeTeam: ArtifactTeam
  awayTeam: ArtifactTeam
  predictionType: PredictionType
  predictionState: PredictionState
  actualScore: ArtifactScore | null
  predictedScoreline: ArtifactScore
  modelVersion: string
  configHash: string
  generatedAt: string
  dataCutoff: string
  eligibleForOfficialAccuracy: false
  probabilities: OneX2Probabilities
  predictedResult: Result
  topScorelines: Array<{ home: number; away: number; probability: number }>
  confidence: ArtifactConfidence
  lambda: { home: number; away: number }
  elo: { home: number; away: number }
  reasons: PredictionReason[]
}

/** Per-match metadata that is not part of the model prediction itself. */
export interface ArtifactMatchMeta {
  id: string
  slug: string
  competitionSlug: string
  season: string
  matchweek: number | null
  kickoffUtc: string
  homeTeam: ArtifactTeam
  awayTeam: ArtifactTeam
  predictionType: PredictionType
  predictionState: PredictionState
  actualScore: ArtifactScore | null
  modelVersion: string
  configHash: string
  generatedAt: string
  dataCutoff: string
  reasonSource: string
}

/** Build one artifact from a model prediction plus its match metadata. */
export function buildPredictionArtifact(pred: MatchPrediction, meta: ArtifactMatchMeta): PredictionArtifact {
  const reasons = pred.reasons.map((r) => mapReason(r, meta.reasonSource))
  if (reasons.length < MIN_ARTIFACT_REASONS) {
    reasons.push(
      buildCoverageReason(
        pred.homeStrength.matchesObserved,
        pred.awayStrength.matchesObserved,
        pred.homeStrength.tier,
        pred.awayStrength.tier,
      ),
    )
  }
  return {
    id: meta.id,
    slug: meta.slug,
    competitionSlug: meta.competitionSlug,
    season: meta.season,
    matchweek: meta.matchweek,
    kickoffUtc: meta.kickoffUtc,
    homeTeam: meta.homeTeam,
    awayTeam: meta.awayTeam,
    predictionType: meta.predictionType,
    predictionState: meta.predictionState,
    actualScore: meta.actualScore,
    predictedScoreline: { home: pred.predictedScoreline.home, away: pred.predictedScoreline.away },
    modelVersion: meta.modelVersion,
    configHash: meta.configHash,
    generatedAt: meta.generatedAt,
    dataCutoff: meta.dataCutoff,
    eligibleForOfficialAccuracy: false,
    probabilities: { home: pred.probabilities.home, draw: pred.probabilities.draw, away: pred.probabilities.away },
    predictedResult: pred.predictedResult,
    topScorelines: pred.topScorelines.map((s) => ({ home: s.home, away: s.away, probability: s.probability })),
    confidence: { score: pred.confidenceScore, level: pred.confidence },
    lambda: { home: pred.lambdaHome, away: pred.lambdaAway },
    elo: { home: pred.eloHome, away: pred.eloAway },
    reasons,
  }
}

/** Stable ordering: kickoff time first, then id (never by clock or randomness). */
export function sortPredictions(artifacts: PredictionArtifact[]): PredictionArtifact[] {
  return [...artifacts].sort((a, b) => {
    if (a.kickoffUtc !== b.kickoffUtc) return a.kickoffUtc < b.kickoffUtc ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}

/* --------------------------- manifest --------------------------- */

export interface PredictionManifest {
  schemaVersion: 1
  competitionSlug: string
  season: string
  modelVersion: string
  configHash: string
  generatedAt: string
  dataCutoff: string
  baseCommit: string
  inputDataHash: string
  generatorHash: string
  totalPredictions: number
  backtestCount: number
  candidateCount: number
  officialPredictionCount: 0
  officialAccuracy: null
  eligibleForOfficialAccuracy: false
  teams: string[]
  source: { provider: string; sourceLastUpdatedAt: string; exportedAt: string }
}

export interface ManifestInput {
  competitionSlug: string
  season: string
  modelVersion: string
  configHash: string
  generatedAt: string
  dataCutoff: string
  baseCommit: string
  inputDataHash: string
  generatorHash: string
  backtestCount: number
  candidateCount: number
  teams: string[]
  source: { provider: string; sourceLastUpdatedAt: string; exportedAt: string }
}

export function buildManifest(input: ManifestInput): PredictionManifest {
  return {
    schemaVersion: 1,
    competitionSlug: input.competitionSlug,
    season: input.season,
    modelVersion: input.modelVersion,
    configHash: input.configHash,
    generatedAt: input.generatedAt,
    dataCutoff: input.dataCutoff,
    baseCommit: input.baseCommit,
    inputDataHash: input.inputDataHash,
    generatorHash: input.generatorHash,
    totalPredictions: input.backtestCount + input.candidateCount,
    backtestCount: input.backtestCount,
    candidateCount: input.candidateCount,
    officialPredictionCount: 0,
    officialAccuracy: null,
    eligibleForOfficialAccuracy: false,
    teams: input.teams,
    source: input.source,
  }
}

/* --------------------------- backtest report --------------------------- */

export interface BacktestReport {
  season: string
  modelVersion: string
  configHash: string
  generatedAt: string
  dataCutoff: string
  matchCount: number
  predictionType: PredictionType
  predictionState: PredictionState
  eligibleForOfficialAccuracy: false
  metrics: PredictionMetrics
  drawMetrics: DrawMetrics
  confusionMatrix: ConfusionMatrix
  predictedOutcomeDistribution: Record<Result, OutcomeDistributionEntry>
  actualOutcomeDistribution: Record<Result, OutcomeDistributionEntry>
  scorelineDistribution: ScorelineCount[]
  confidenceBreakdown: Record<ConfidenceLevel, ConfidenceBreakdown>
}

export interface BacktestReportInput {
  season: string
  modelVersion: string
  configHash: string
  generatedAt: string
  dataCutoff: string
}

export function buildBacktestReport(predictions: MatchPrediction[], input: BacktestReportInput): BacktestReport {
  return {
    season: input.season,
    modelVersion: input.modelVersion,
    configHash: input.configHash,
    generatedAt: input.generatedAt,
    dataCutoff: input.dataCutoff,
    matchCount: predictions.length,
    predictionType: "backtest",
    predictionState: "historical_reconstruction",
    eligibleForOfficialAccuracy: false,
    metrics: computeMetrics(predictions),
    drawMetrics: computeDrawMetrics(predictions),
    confusionMatrix: computeConfusionMatrix(predictions),
    predictedOutcomeDistribution: predictedOutcomeDistribution(predictions),
    actualOutcomeDistribution: actualOutcomeDistribution(predictions),
    scorelineDistribution: scorelineDistribution(predictions),
    confidenceBreakdown: computeConfidenceBreakdown(predictions),
  }
}
