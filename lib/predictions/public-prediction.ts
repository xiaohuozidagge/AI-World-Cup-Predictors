/**
 * Public (page-facing) prediction layer for the 380 Premier League match detail
 * pages (Phase IX).
 *
 * This module is the single build-time reader of the Phase VIII seal artifacts.
 * It reads the five seal-artifact files that back the effective catalog and joins them
 * by `matchId` into one unified `PublicMatchPrediction` object per fixture, then
 * validates the whole seal at load time — a hash or integrity mismatch throws,
 * which fails the build instead of silently hiding a prediction card.
 *
 * Rules enforced here (and re-checked by `public-prediction.test.ts`):
 *   - `effectiveCatalogHash`, `sealedPredictionsHash`, `sourcePredictionsHash`
 *     and `eligibilityOverridesHash` all match the seal manifest;
 *   - 380 total = 40 original backtests + 10 late backtests + 330 sealed
 *     candidates, with unique `matchId`/`slug`;
 *   - the 330 sealed candidates all come from the sealed snapshot (not the raw
 *     Phase VII candidates) and are unpublished / not officially eligible;
 *   - the 50 backtests are all permanently ineligible;
 *   - every Premier League fixture maps to exactly one prediction and vice
 *     versa (team slugs included), so no page can render without a prediction.
 *
 * There is no Supabase, no `fetch`, no `await`, no clock, and no model call —
 * everything is a pure function of the bundled JSON snapshots, so the pages can
 * prerender statically.
 */

import "server-only"

import type { FixtureStatus } from "../supabase/types"
import {
  type ArtifactConfidence,
  type ArtifactScore,
  type ArtifactTeam,
  type PredictionArtifact,
  type PredictionReason,
} from "../model/prediction-artifact"
import type { OneX2Probabilities, Result } from "../model/types"
import type { EffectiveCatalogFile, EligibilityOverridesFile } from "./prediction-classification"
import { hashObject, type RemainingFutureSealedFile, type SealManifest, type SealedPrediction } from "./prediction-lock"
import { getStaticFixturesForCompetition } from "../football/static-data"

import { readFileSync } from "fs"
import { join } from "path"

/* --------------------------- public shapes --------------------------- */

/**
 * The three page states. `backtest` = the 40 original historical backtests,
 * `historical_reconstruction` = the 10 late (post-event) backtests, `sealed` =
 * the 330 sealed-but-unpublished candidates.
 */
export type PublicPredictionStatus = "backtest" | "historical_reconstruction" | "sealed"

/** A fixture-shaped input the page already has, used to join to a prediction. */
export interface PredictionFixtureInput {
  providerFixtureId: number
  homeTeam: { slug: string }
  awayTeam: { slug: string }
  status: FixtureStatus
  homeScore: number | null
  awayScore: number | null
}

export interface PublicMatchPrediction {
  matchId: string
  slug: string
  status: PublicPredictionStatus
  /** The sealed/predicted scoreline (never the actual score). */
  predictedScore: ArtifactScore
  predictedResult: Result
  probabilities: OneX2Probabilities
  confidence: ArtifactConfidence
  reasons: PredictionReason[]
  topScorelines: Array<{ home: number; away: number; probability: number }>
  /** The match's actual score (null until the fixture is FINISHED). */
  actualScore: ArtifactScore | null
  modelVersion: string
  generatedAt: string
  dataCutoff: string
  sealedAt: string | null
  publishedAt: null
  eligibleForOfficialAccuracy: false
  kickoffUtc: string
  homeTeam: ArtifactTeam
  awayTeam: ArtifactTeam
}

export interface PublicPredictionCounts {
  total: number
  backtest: number
  historicalReconstruction: number
  sealed: number
  permanentlyIneligible: number
  published: number
}

/* --------------------------- load-time validation --------------------------- */

function fail(message: string): never {
  throw new Error(`[public-prediction] ${message}`)
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) fail(message)
}

/**
 * Pure, build-failing integrity check over the parsed seal artifacts. Throws on
 * any hash/count/consistency mismatch. Kept as a standalone function so the
 * tests can feed it a tampered copy and assert that the build would fail.
 */
export function validatePredictionSealIntegrity(input: {
  manifest: SealManifest
  predictions: PredictionArtifact[]
  sealed: RemainingFutureSealedFile
  catalog: EffectiveCatalogFile
  overrides: EligibilityOverridesFile
}): void {
  const { manifest, predictions, sealed, catalog, overrides } = input

  /* ---- cross-file hashes (a mismatch must fail the build) ---- */
  assert(hashObject(predictions) === manifest.sourcePredictionsHash, "sourcePredictionsHash mismatch — predictions.json changed")
  assert(hashObject(overrides) === manifest.eligibilityOverridesHash, "eligibilityOverridesHash mismatch — eligibility-overrides.json changed")
  assert(hashObject(sealed) === manifest.sealedPredictionsHash, "sealedPredictionsHash mismatch — sealed-predictions.json changed")
  assert(hashObject(catalog) === manifest.effectiveCatalogHash, "effectiveCatalogHash mismatch — effective-prediction-catalog.json changed")

  /* ---- manifest invariants ---- */
  assert(manifest.sealMode === "remaining_future_season_publication", "sealMode must be remaining_future_season_publication")
  assert(manifest.totalPredictions === 380, "manifest totalPredictions must be 380")
  assert(manifest.originalBacktestCount === 40, "manifest originalBacktestCount must be 40")
  assert(manifest.lateBacktestCount === 10, "manifest lateBacktestCount must be 10")
  assert(manifest.totalBacktestCount === 50, "manifest totalBacktestCount must be 50")
  assert(manifest.sealedCandidateCount === 330, "manifest sealedCandidateCount must be 330")
  assert(manifest.publishedPredictionCount === 0, "manifest publishedPredictionCount must be 0")
  assert(manifest.officialPredictionCount === 0, "manifest officialPredictionCount must be 0")
  assert(manifest.officialAccuracy === null, "manifest officialAccuracy must be null")

  /* ---- per-file counts ---- */
  assert(predictions.length === 380, "predictions.json must hold exactly 380 artifacts")
  assert(catalog.totalPredictions === 380 && catalog.entries.length === 380, "catalog must hold exactly 380 entries")
  assert(sealed.candidates.length === 330, "sealed-predictions.json must hold exactly 330 candidates")
  assert(overrides.overrides.length === 10 && overrides.lateBacktestCount === 10, "eligibility-overrides.json must hold exactly 10 overrides")

  /* ---- unique ids and slugs ---- */
  const predictionIds = new Set(predictions.map((p) => p.id))
  assert(predictionIds.size === 380, "prediction ids must be unique")
  const predictionSlugs = new Set(predictions.map((p) => p.slug))
  assert(predictionSlugs.size === 380, "prediction slugs must be unique")
  for (const p of predictions) {
    assert(p.id === `pl-2026-27-${p.slug}`, `prediction ${p.id} does not match prefix+slug`)
  }

  const predictionsById = new Map(predictions.map((p) => [p.id, p]))
  const sealedById = new Map(sealed.candidates.map((s) => [s.id, s]))
  assert(sealedById.size === 330, "sealed candidate ids must be unique")

  /* ---- catalog classification: 40 / 10 / 330 ---- */
  const catalogById = new Map<string, (typeof catalog.entries)[number]>()
  for (const e of catalog.entries) {
    assert(!catalogById.has(e.matchId), `duplicate catalog matchId ${e.matchId}`)
    catalogById.set(e.matchId, e)
  }
  assert(catalogById.size === 380, "catalog matchIds must be unique")

  const historical = catalog.entries.filter((e) => e.effectivePredictionState === "historical_reconstruction")
  const postEvent = catalog.entries.filter((e) => e.effectivePredictionState === "post_event_reconstruction")
  const sealedEntries = catalog.entries.filter((e) => e.effectivePredictionState === "sealed")
  assert(historical.length === 40, "catalog must classify exactly 40 historical (original backtest) entries")
  assert(postEvent.length === 10, "catalog must classify exactly 10 post-event (late backtest) entries")
  assert(sealedEntries.length === 330, "catalog must classify exactly 330 sealed entries")

  /* ---- the 50 backtests are all permanently ineligible ---- */
  for (const e of [...historical, ...postEvent]) {
    assert(e.effectivePredictionType === "backtest", `${e.matchId} must be an effective backtest`)
    assert(e.permanentlyIneligible === true, `${e.matchId} backtest must be permanently ineligible`)
    assert(e.eligibleForOfficialAccuracy === false, `${e.matchId} backtest must not be officially eligible`)
    assert(e.publishedAt === null, `${e.matchId} backtest must not be published`)
  }

  /* ---- the 330 sealed candidates come from the sealed snapshot ---- */
  for (const e of sealedEntries) {
    assert(e.effectivePredictionType === "candidate", `${e.matchId} sealed entry must be a candidate`)
    assert(e.permanentlyIneligible === false, `${e.matchId} sealed entry must not be permanently ineligible`)
    assert(e.publishedAt === null, `${e.matchId} sealed entry must not be published`)
    assert(e.eligibleForOfficialAccuracy === false, `${e.matchId} sealed entry must not be officially eligible`)
    const s = sealedById.get(e.matchId)
    assert(s, `sealed entry ${e.matchId} missing from sealed snapshot`)
    assert(s.predictionState === "sealed", `${e.matchId} is not sealed in the snapshot`)
    assert(s.publishedAt === null, `${e.matchId} sealed candidate must not be published`)
    assert(s.eligibleForOfficialAccuracy === false, `${e.matchId} sealed candidate must not be officially eligible`)
    assert(s.finalPredictionHash === hashObject(s.prediction), `${e.matchId} finalPredictionHash mismatch against snapshot`)
    assert(e.finalPredictionHash === s.finalPredictionHash, `${e.matchId} catalog finalPredictionHash drift from snapshot`)
    const original = predictionsById.get(e.matchId)
    assert(original, `sealed entry ${e.matchId} missing from predictions.json`)
    assert(s.originalPredictionHash === hashObject(original), `${e.matchId} sealed originalPredictionHash mismatch`)
    // The sealed snapshot must carry the same core prediction as the Phase VII
    // candidate, differing only in `predictionState`.
    assert(
      hashObject({ ...original, predictionState: "sealed" }) === hashObject(s.prediction),
      `${e.matchId} sealed snapshot core fields drifted from the Phase VII candidate`,
    )
  }

  /* ---- the 10 overrides reference real candidates ---- */
  const overrideIds = new Set<string>()
  for (const o of overrides.overrides) {
    assert(!overrideIds.has(o.matchId), `duplicate override matchId ${o.matchId}`)
    overrideIds.add(o.matchId)
    assert(o.permanentlyIneligible === true, `${o.matchId} override must be permanently ineligible`)
    assert(o.effectivePredictionState === "post_event_reconstruction", `${o.matchId} override state mismatch`)
    const original = predictionsById.get(o.matchId)
    assert(original, `override ${o.matchId} missing from predictions.json`)
    assert(original.predictionType === "candidate", `${o.matchId} override must reference a candidate`)
    assert(o.originalPredictionHash === hashObject(original), `${o.matchId} override originalPredictionHash mismatch`)
    const entry = catalogById.get(o.matchId)
    assert(entry && entry.effectivePredictionState === "post_event_reconstruction", `${o.matchId} has no post-event catalog entry`)
  }
}

/* --------------------------- building --------------------------- */

/**
 * The prediction fields shared by a Phase VII artifact and its sealed snapshot —
 * identical except for `predictionState`, which this layer never reads.
 */
type PredictionCore = Omit<PredictionArtifact, "predictionState">

/** Source the artifact for a catalog entry: backtest, original candidate, or sealed snapshot. */
function resolveArtifact(entry: EffectiveCatalogFile["entries"][number], input: {
  predictionsById: Map<string, PredictionArtifact>
  sealedById: Map<string, SealedPrediction>
}): PredictionCore {
  const original = input.predictionsById.get(entry.matchId)
  assert(original, `catalog entry ${entry.matchId} missing from predictions.json`)
  if (entry.effectivePredictionState === "sealed") {
    const s = input.sealedById.get(entry.matchId)
    assert(s, `sealed entry ${entry.matchId} missing from sealed snapshot`)
    return s.prediction
  }
  return original
}

function toStatus(entry: EffectiveCatalogFile["entries"][number]): PublicPredictionStatus {
  switch (entry.effectivePredictionState) {
    case "historical_reconstruction":
      return "backtest"
    case "post_event_reconstruction":
      return "historical_reconstruction"
    case "sealed":
      return "sealed"
  }
}

/**
 * Pure builder over the parsed seal artifacts: 380 `PublicMatchPrediction`
 * objects keyed by `providerFixtureId`, plus a count summary. No football data
 * is read here — the fixture cross-check happens in `validateFixtureCoverage`.
 */
export function buildPublicPredictions(input: {
  predictions: PredictionArtifact[]
  sealed: RemainingFutureSealedFile
  catalog: EffectiveCatalogFile
}): { byFixtureId: Map<number, PublicMatchPrediction>; counts: PublicPredictionCounts } {
  const predictionsById = new Map(input.predictions.map((p) => [p.id, p]))
  const sealedById = new Map(input.sealed.candidates.map((s) => [s.id, s]))

  const byFixtureId = new Map<number, PublicMatchPrediction>()
  const counts: PublicPredictionCounts = {
    total: 0,
    backtest: 0,
    historicalReconstruction: 0,
    sealed: 0,
    permanentlyIneligible: 0,
    published: 0,
  }

  for (const entry of input.catalog.entries) {
    const artifact = resolveArtifact(entry, { predictionsById, sealedById })
    const fixtureId = parseFixtureId(entry.matchId)
    assert(fixtureId != null, `catalog entry ${entry.matchId} has no provider fixture id`)
    assert(!byFixtureId.has(fixtureId), `duplicate provider fixture id ${fixtureId}`)

    const status = toStatus(entry)
    const p: PublicMatchPrediction = {
      matchId: entry.matchId,
      slug: artifact.slug,
      status,
      predictedScore: { home: artifact.predictedScoreline.home, away: artifact.predictedScoreline.away },
      predictedResult: artifact.predictedResult,
      probabilities: { home: artifact.probabilities.home, draw: artifact.probabilities.draw, away: artifact.probabilities.away },
      confidence: { score: artifact.confidence.score, level: artifact.confidence.level },
      reasons: artifact.reasons,
      topScorelines: artifact.topScorelines.map((s) => ({ home: s.home, away: s.away, probability: s.probability })),
      // The recorded actual score from the artifact (backtests only); the page
      // layer replaces this with the fixture's live score via getPublicMatchPrediction.
      actualScore: artifact.actualScore ? { home: artifact.actualScore.home, away: artifact.actualScore.away } : null,
      modelVersion: artifact.modelVersion,
      generatedAt: artifact.generatedAt,
      dataCutoff: artifact.dataCutoff,
      sealedAt: entry.sealedAt,
      publishedAt: null,
      eligibleForOfficialAccuracy: false,
      kickoffUtc: artifact.kickoffUtc,
      homeTeam: { slug: artifact.homeTeam.slug, name: artifact.homeTeam.name, shortName: artifact.homeTeam.shortName },
      awayTeam: { slug: artifact.awayTeam.slug, name: artifact.awayTeam.name, shortName: artifact.awayTeam.shortName },
    }

    byFixtureId.set(fixtureId, p)
    counts.total += 1
    if (status === "backtest") counts.backtest += 1
    else if (status === "historical_reconstruction") counts.historicalReconstruction += 1
    else counts.sealed += 1
    if (entry.permanentlyIneligible) counts.permanentlyIneligible += 1
    if (entry.publishedAt != null) counts.published += 1
  }

  assert(counts.total === 380, "built 380 predictions")
  assert(counts.backtest === 40, "built 40 backtest predictions")
  assert(counts.historicalReconstruction === 10, "built 10 historical reconstructions")
  assert(counts.sealed === 330, "built 330 sealed predictions")
  assert(counts.permanentlyIneligible === 50, "built 50 permanently ineligible predictions")
  assert(counts.published === 0, "built 0 published predictions")

  return { byFixtureId, counts }
}

/** The trailing provider-fixture-id of a prediction `id`/`slug`. */
function parseFixtureId(value: string): number | null {
  const last = value.slice(value.lastIndexOf("-") + 1)
  if (!/^\d+$/.test(last)) return null
  const n = Number(last)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Cross-check every fixture ↔ exactly one prediction (both directions). */
export function validateFixtureCoverage(
  byFixtureId: Map<number, PublicMatchPrediction>,
  fixtures: Array<{ providerFixtureId: number; homeTeam: { slug: string }; awayTeam: { slug: string } }>,
): void {
  const fixtureIds = new Set<number>()
  for (const f of fixtures) {
    assert(!fixtureIds.has(f.providerFixtureId), `duplicate fixture provider id ${f.providerFixtureId}`)
    fixtureIds.add(f.providerFixtureId)
    const p = byFixtureId.get(f.providerFixtureId)
    assert(p, `fixture ${f.providerFixtureId} has no prediction`)
    assert(p.homeTeam.slug === f.homeTeam.slug, `fixture ${f.providerFixtureId} home slug mismatch`)
    assert(p.awayTeam.slug === f.awayTeam.slug, `fixture ${f.providerFixtureId} away slug mismatch`)
  }
  assert(fixtureIds.size === byFixtureId.size, "fixture count does not match prediction count")
  for (const id of byFixtureId.keys()) {
    assert(fixtureIds.has(id), `prediction ${id} has no fixture`)
  }
}

/* --------------------------- module wiring --------------------------- */

// Read each bundled seal artifact via `fs` + `JSON.parse` — the exact path the
// seal script used to compute the manifest hashes. We deliberately avoid
// Turbopack's JSON-import loader here: it round-trips float literals through
// Rust's `f64::to_string`, which can differ from V8's `JSON.parse` by up to one
// ULP on the 17-significant-digit probabilities/confidence values, and would
// make `validatePredictionSealIntegrity` fail the build on byte-identical files.
// The directory is statically scoped (not a variable path) so Turbopack traces
// only this subfolder instead of the whole project.
const predictionsDataDir = join(process.cwd(), "data", "predictions", "premier-league", "2026-27")

const manifest = JSON.parse(readFileSync(join(predictionsDataDir, "seal-manifest.json"), "utf8")) as SealManifest
const predictions = JSON.parse(readFileSync(join(predictionsDataDir, "predictions.json"), "utf8")) as PredictionArtifact[]
const sealed = JSON.parse(readFileSync(join(predictionsDataDir, "sealed-predictions.json"), "utf8")) as RemainingFutureSealedFile
const catalog = JSON.parse(readFileSync(join(predictionsDataDir, "effective-prediction-catalog.json"), "utf8")) as EffectiveCatalogFile
const overrides = JSON.parse(readFileSync(join(predictionsDataDir, "eligibility-overrides.json"), "utf8")) as EligibilityOverridesFile

validatePredictionSealIntegrity({ manifest, predictions, sealed, catalog, overrides })

const built = buildPublicPredictions({ predictions, sealed, catalog })

export const publicPredictionCounts: Readonly<PublicPredictionCounts> = built.counts

// Tie the two snapshots together once at load: every Premier League fixture maps
// to exactly one prediction (and vice versa). Any mismatch fails the build.
validateFixtureCoverage(built.byFixtureId, getStaticFixturesForCompetition("premier-league"))

/**
 * Resolve the sealed prediction for a fixture (never null for a PL match, since
 * the build has already asserted all 380 fixtures are covered). The returned
 * object's `actualScore` reflects the fixture's live score at build time.
 */
export function getPublicMatchPrediction(fixture: PredictionFixtureInput): PublicMatchPrediction {
  const base = built.byFixtureId.get(fixture.providerFixtureId)
  assert(base, `no prediction for fixture ${fixture.providerFixtureId}`)

  let actualScore: ArtifactScore | null = null
  if (fixture.status === "FINISHED" && fixture.homeScore != null && fixture.awayScore != null) {
    actualScore = { home: fixture.homeScore, away: fixture.awayScore }
  }

  return { ...base, actualScore }
}

/** All 380 predictions, for tests and any future consumers. */
export function getAllPublicPredictions(): PublicMatchPrediction[] {
  return [...built.byFixtureId.values()]
}

/* --------------------------- display helpers --------------------------- */

export const UNIVERSAL_DISCLAIMER =
  "AI predictions are statistical estimates based on historical match data. They do not guarantee future results and should not be treated as betting or financial advice."

export interface PredictionStatusMeta {
  status: PublicPredictionStatus
  label: string
  description: string
  badgeVariant: "secondary" | "info" | "success" | "warning"
  extraDisclaimers: string[]
}

export function predictionStatusMeta(status: PublicPredictionStatus): PredictionStatusMeta {
  switch (status) {
    case "backtest":
      return {
        status,
        label: "Backtest",
        description:
          "This prediction was reconstructed using only information available before kickoff. It is shown for model evaluation and is excluded from the official prediction record.",
        badgeVariant: "secondary",
        extraDisclaimers: ["Backtest results are excluded from the official prediction accuracy record."],
      }
    case "historical_reconstruction":
      return {
        status,
        label: "Historical Reconstruction",
        description:
          "This forecast was generated after kickoff from a pre-match data snapshot. It is provided as a historical reconstruction and is permanently excluded from official accuracy.",
        badgeVariant: "warning",
        extraDisclaimers: [
          "This historical reconstruction was generated after kickoff and is permanently excluded from official accuracy.",
        ],
      }
    case "sealed":
      return {
        status,
        label: "Sealed AI Prediction",
        description:
          "This prediction was generated and sealed before kickoff. It will become eligible for the official record only if published before the match starts.",
        badgeVariant: "info",
        extraDisclaimers: [],
      }
  }
}

export function resultLabel(result: Result): string {
  switch (result) {
    case "H":
      return "Home Win"
    case "D":
      return "Draw"
    case "A":
      return "Away Win"
  }
}

export function confidenceLabel(level: ArtifactConfidence["level"]): string {
  switch (level) {
    case "low":
      return "Low Confidence"
    case "medium":
      return "Medium Confidence"
    case "high":
      return "High Confidence"
  }
}

export function confidenceExplanation(level: ArtifactConfidence["level"]): string {
  switch (level) {
    case "low":
      return "Outcome probabilities are close together, so uncertainty is higher."
    case "medium":
      return "The model shows a moderate lean toward one outcome."
    case "high":
      return "The model's lean is relatively clear."
  }
}

/**
 * Largest-remainder rounding of the three 1X2 probabilities into integer
 * percentages that always sum to exactly 100, without mutating the raw
 * high-precision values. Deterministic (ties broken by index order).
 */
export function largestRemainderPercentages(home: number, draw: number, away: number): [number, number, number] {
  const scaled = [home, draw, away].map((v) => v * 100)
  const floors = scaled.map((v) => Math.floor(v))
  const remainders = scaled.map((v, i) => v - floors[i])
  let remaining = 100 - floors.reduce((a, b) => a + b, 0)
  const order = [0, 1, 2].sort((a, b) => remainders[b] - remainders[a] || a - b)
  for (let i = 0; i < order.length && remaining > 0; i++) {
    floors[order[i]] += 1
    remaining -= 1
  }
  return [floors[0], floors[1], floors[2]]
}

/* --------------------------- comparison --------------------------- */

export type ComparisonOutcome = "exact" | "result" | "missed" | "pending" | "not_synced"

export interface PredictionComparison {
  outcome: ComparisonOutcome
  rows: Array<{ label: "Score" | "Result"; predicted: string; actual: string }>
  note: string
}

export function resultOfScore(score: ArtifactScore): Result {
  if (score.home > score.away) return "H"
  if (score.home < score.away) return "A"
  return "D"
}

/**
 * Predicted-vs-actual comparison. Uses `prediction.actualScore` (the fixture's
 * live score on the page path) — never guesses a result when there is none.
 */
export function buildComparison(prediction: PublicMatchPrediction): PredictionComparison {
  const actual = prediction.actualScore
  if (!actual) {
    if (prediction.status === "historical_reconstruction") {
      return { outcome: "not_synced", rows: [], note: "Result not yet synced" }
    }
    return { outcome: "pending", rows: [], note: "Actual result available after the match" }
  }

  const actualResult = resultOfScore(actual)
  const rows: PredictionComparison["rows"] = [
    {
      label: "Score",
      predicted: `${prediction.predictedScore.home}–${prediction.predictedScore.away}`,
      actual: `${actual.home}–${actual.away}`,
    },
    {
      label: "Result",
      predicted: resultLabel(prediction.predictedResult),
      actual: resultLabel(actualResult),
    },
  ]

  let outcome: ComparisonOutcome
  if (prediction.predictedScore.home === actual.home && prediction.predictedScore.away === actual.away) {
    outcome = "exact"
  } else if (prediction.predictedResult === actualResult) {
    outcome = "result"
  } else {
    outcome = "missed"
  }

  const note =
    prediction.status === "historical_reconstruction"
      ? "Historical reconstruction — permanently excluded from official accuracy"
      : "Backtest evaluation — not included in official accuracy"

  return { outcome, rows, note }
}

/* --------------------------- transparency --------------------------- */

export interface TransparencyRow {
  label: string
  value: string
}

const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "September 21, 2026" (UTC, full month name). */
export function formatTransparencyDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return `${FULL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/** "September 18, 2026, 00:20" (UTC, full month name). */
export function formatTransparencyDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mm = String(d.getUTCMinutes()).padStart(2, "0")
  return `${FULL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm}`
}

export function transparencyRows(p: PublicMatchPrediction): TransparencyRow[] {
  const rows: TransparencyRow[] = [
    { label: "Model", value: `Premier League Prediction Model v${p.modelVersion}` },
    { label: "Data through", value: `${formatTransparencyDateTime(p.dataCutoff)} UTC` },
    { label: "Prediction generated", value: formatTransparencyDate(p.generatedAt) },
  ]
  if (p.sealedAt) rows.push({ label: "Sealed", value: formatTransparencyDate(p.sealedAt) })
  rows.push({ label: "Fixture and result data", value: "football-data.org" })
  return rows
}

/** Whether the fixture's result has been synced at build time (for late backtests). */
export function hasActualScore(prediction: PublicMatchPrediction): boolean {
  return prediction.actualScore !== null
}
