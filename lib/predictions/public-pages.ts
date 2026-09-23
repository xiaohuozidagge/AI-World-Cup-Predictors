/**
 * Build-time aggregation layer for the Phase X core pages (home, "today",
 * accuracy, Premier League landing). It is a thin, read-only summary over the
 * Phase IX public prediction layer and the football snapshot — it never reads
 * the large raw JSON files directly, never re-runs the model, and never touches
 * the network, Supabase, the clock, or the browser.
 *
 * Every page that consumes this module prerenders statically from the committed
 * snapshots:
 *   - predictions come from `./public-prediction` (seal artifacts + effective
 *     catalog), which already validates hashes and the 40/10/330 split at load;
 *   - the 40-match backtest metrics come from `backtest-report.json`;
 *   - the schedule reference date comes from the football snapshot manifest
 *     (`sourceLastUpdatedAt`) — never from `Date.now()`, so the "today" page is
 *     reproducible at build time and updates automatically on the next snapshot.
 */

import "server-only"

import { readFileSync } from "fs"
import { join } from "path"

import { staticManifest, getStaticFixturesForCompetition } from "../football/static-data"
import {
  confidenceLabel,
  formatTransparencyDate,
  getAllPublicPredictions,
  largestRemainderPercentages,
  predictionStatusMeta,
  publicPredictionCounts,
  resultLabel,
  type PublicMatchPrediction,
  type PublicPredictionStatus,
} from "./public-prediction"

/* --------------------------- shapes --------------------------- */

export interface PredictionCard {
  slug: string
  /** Relative match detail URL, e.g. `/premier-league/matches/arsenal-fc-vs-...-560542`. */
  url: string
  kickoffUtc: string
  homeName: string
  awayName: string
  homeShort: string
  awayShort: string
  predictedScore: { home: number; away: number }
  predictedResult: string
  /** Integer 1X2 percentages that always sum to exactly 100. */
  percentages: [number, number, number]
  confidenceLevel: "low" | "medium" | "high"
  confidenceLabel: string
  status: PublicPredictionStatus
  statusLabel: string
  statusBadgeVariant: "secondary" | "info" | "success" | "warning"
  actualScore: { home: number; away: number } | null
}

export interface SeasonSnapshot {
  totalFixtures: number
  sealedPredictions: number
  originalBacktests: number
  historicalReconstructions: number
  officialResults: number
  published: number
  scheduleUpdatedAt: string
}

export interface TodayPageData {
  referenceDateLabel: string
  scheduleUpdatedAt: string
  isToday: boolean
  heading: string
  matches: PredictionCard[]
  latestReviews: PredictionCard[]
}

export interface BacktestMetrics {
  sampleSize: number
  accuracy1X2: number
  exactScoreAccuracy: number
  brierScore: number
  logLoss: number
}

export interface AccuracyPageData {
  officialPredictionCount: number
  officialAccuracy: null
  manualAdjustments: number
  backtest: BacktestMetrics
}

export interface TeamEntry {
  name: string
  slug: string
  url: string
}

export interface PremierLeaguePageData {
  snapshot: SeasonSnapshot
  nextMatchday: PredictionCard[]
  latestReviews: PredictionCard[]
  teams: TeamEntry[]
}

export interface HomePageData {
  snapshot: SeasonSnapshot
  upcoming: PredictionCard[]
}

/* --------------------------- module wiring --------------------------- */

// Same statically-scoped directory as `public-prediction.ts`, so Turbopack
// traces only this subfolder. The backtest metrics are read via `fs` + `JSON.parse`
// for exact float values (not re-hashed, but kept byte-consistent with the source).
const predictionsDataDir = join(process.cwd(), "data", "predictions", "premier-league", "2026-27")

interface BacktestReportFile {
  metrics: {
    matchCount: number
    accuracy1X2: number
    exactScoreAccuracy: number
    brierScore: number
    logLoss: number
  }
}

const backtestReport = JSON.parse(
  readFileSync(join(predictionsDataDir, "backtest-report.json"), "utf8"),
) as BacktestReportFile

const all = getAllPublicPredictions()

/**
 * The schedule reference date: the football snapshot's `sourceLastUpdatedAt`
 * (falling back to the model `dataCutoff`). This is the only "now" the static
 * pages are allowed to use — never `Date.now()` or browser time.
 */
const sourceUpdatedAt = staticManifest.sourceLastUpdatedAt ?? all[0].dataCutoff

function dateOnlyUtc(iso: string): string {
  return iso.slice(0, 10)
}

/* --------------------------- helpers --------------------------- */

function toPredictionCard(p: PublicMatchPrediction): PredictionCard {
  const meta = predictionStatusMeta(p.status)
  const [homePct, drawPct, awayPct] = largestRemainderPercentages(
    p.probabilities.home,
    p.probabilities.draw,
    p.probabilities.away,
  )
  return {
    slug: p.slug,
    url: `/premier-league/matches/${p.slug}`,
    kickoffUtc: p.kickoffUtc,
    homeName: p.homeTeam.name,
    awayName: p.awayTeam.name,
    homeShort: p.homeTeam.shortName ?? p.homeTeam.name,
    awayShort: p.awayTeam.shortName ?? p.awayTeam.name,
    predictedScore: { home: p.predictedScore.home, away: p.predictedScore.away },
    predictedResult: resultLabel(p.predictedResult),
    percentages: [homePct, drawPct, awayPct],
    confidenceLevel: p.confidence.level,
    confidenceLabel: confidenceLabel(p.confidence.level),
    status: p.status,
    statusLabel: meta.label,
    statusBadgeVariant: meta.badgeVariant,
    actualScore: p.actualScore,
  }
}

const sealedSorted = all
  .filter((p) => p.status === "sealed")
  .sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc))

/** The earliest future matchday (grouped by kickoff UTC date) at or after the snapshot date. */
function resolveNextMatchday(): { date: string; isToday: boolean; matches: PublicMatchPrediction[] } {
  const referenceDate = dateOnlyUtc(sourceUpdatedAt)
  const dates = [...new Set(sealedSorted.map((p) => dateOnlyUtc(p.kickoffUtc)))].sort()
  const next = dates.find((d) => d >= referenceDate) ?? dates[dates.length - 1]
  const matches = sealedSorted
    .filter((p) => dateOnlyUtc(p.kickoffUtc) === next)
    .sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc))
  return { date: next, isToday: next === referenceDate, matches }
}

/* --------------------------- queries --------------------------- */

export function getSeasonSnapshot(): SeasonSnapshot {
  return {
    totalFixtures: publicPredictionCounts.total,
    sealedPredictions: publicPredictionCounts.sealed,
    originalBacktests: publicPredictionCounts.backtest,
    historicalReconstructions: publicPredictionCounts.historicalReconstruction,
    // The seal manifest pins officialPredictionCount to 0 for this phase.
    officialResults: 0,
    published: publicPredictionCounts.published,
    scheduleUpdatedAt: sourceUpdatedAt,
  }
}

/** The sealed predictions on the next (or today's) matchday, in kickoff order. */
export function getNextMatchdayPredictions(limit = 12): PredictionCard[] {
  return resolveNextMatchday().matches.slice(0, limit).map(toPredictionCard)
}

/** The most recent original backtests that carry a synced result, newest first. */
export function getLatestReviews(limit = 6): PredictionCard[] {
  return all
    .filter((p) => p.status === "backtest" && p.actualScore !== null)
    .sort((a, b) => b.kickoffUtc.localeCompare(a.kickoffUtc))
    .slice(0, limit)
    .map(toPredictionCard)
}

export function getTodayPageData(): TodayPageData {
  const { isToday, matches } = resolveNextMatchday()
  return {
    referenceDateLabel: formatTransparencyDate(sourceUpdatedAt),
    scheduleUpdatedAt: sourceUpdatedAt,
    isToday,
    heading: isToday ? "Football Predictions Today" : "Next Football Predictions",
    matches: matches.map(toPredictionCard),
    latestReviews: getLatestReviews(6),
  }
}

export function getAccuracyPageData(): AccuracyPageData {
  return {
    // Pinned by the seal manifest; becomes non-zero only once predictions are
    // published and results are synced (Phase XIII+).
    officialPredictionCount: 0,
    officialAccuracy: null,
    manualAdjustments: 0,
    backtest: {
      sampleSize: backtestReport.metrics.matchCount,
      accuracy1X2: backtestReport.metrics.accuracy1X2,
      exactScoreAccuracy: backtestReport.metrics.exactScoreAccuracy,
      brierScore: backtestReport.metrics.brierScore,
      logLoss: backtestReport.metrics.logLoss,
    },
  }
}

export function getPremierLeagueTeams(): TeamEntry[] {
  const teams = new Map<string, { name: string; slug: string }>()
  for (const f of getStaticFixturesForCompetition("premier-league")) {
    teams.set(f.homeTeam.id, { name: f.homeTeam.name, slug: f.homeTeam.slug })
    teams.set(f.awayTeam.id, { name: f.awayTeam.name, slug: f.awayTeam.slug })
  }
  return [...teams.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, slug: t.slug, url: `/clubs/${t.slug}` }))
}

export function getPremierLeaguePageData(): PremierLeaguePageData {
  return {
    snapshot: getSeasonSnapshot(),
    nextMatchday: getNextMatchdayPredictions(10),
    latestReviews: getLatestReviews(6),
    teams: getPremierLeagueTeams(),
  }
}

export function getHomePageData(): HomePageData {
  return {
    snapshot: getSeasonSnapshot(),
    upcoming: getNextMatchdayPredictions(6),
  }
}
