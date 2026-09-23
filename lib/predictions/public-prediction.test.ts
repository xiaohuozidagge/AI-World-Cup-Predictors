/**
 * Tests for the Phase IX public prediction layer: the 380 effective-catalog
 * mappings (40 backtests / 10 historical reconstructions / 330 sealed), the
 * build-time hash validation, the display helpers (largest-remainder
 * percentages, confidence, reasons, comparison, disclaimers), and the static
 * guarantees that the page never calls the network, Supabase, or the model.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { PredictionArtifact } from "../model/prediction-artifact"
import type { Result } from "../model/types"
import type { EffectiveCatalogFile, EligibilityOverridesFile } from "./prediction-classification"
import type { RemainingFutureSealedFile, SealManifest } from "./prediction-lock"
import {
  buildComparison,
  buildPublicPredictions,
  confidenceExplanation,
  confidenceLabel,
  formatTransparencyDate,
  formatTransparencyDateTime,
  getAllPublicPredictions,
  getPublicMatchPrediction,
  largestRemainderPercentages,
  predictionStatusMeta,
  publicPredictionCounts,
  resultLabel,
  transparencyRows,
  UNIVERSAL_DISCLAIMER,
  validatePredictionSealIntegrity,
  type PublicMatchPrediction,
} from "./public-prediction"
import { getStaticPremierLeagueMatchParams, resolveStaticMatch } from "../football/static-queries"
import { footballMatchJsonLd } from "../jsonld"

import predictionsJson from "../../data/predictions/premier-league/2026-27/predictions.json"
import sealedJson from "../../data/predictions/premier-league/2026-27/sealed-predictions.json"
import manifestJson from "../../data/predictions/premier-league/2026-27/seal-manifest.json"
import catalogJson from "../../data/predictions/premier-league/2026-27/effective-prediction-catalog.json"
import overridesJson from "../../data/predictions/premier-league/2026-27/eligibility-overrides.json"

const rawPredictions = predictionsJson as unknown as PredictionArtifact[]
const rawSealed = sealedJson as unknown as RemainingFutureSealedFile
const rawManifest = manifestJson as unknown as SealManifest
const rawCatalog = catalogJson as unknown as EffectiveCatalogFile
const rawOverrides = overridesJson as unknown as EligibilityOverridesFile

const byId = new Map(rawPredictions.map((p) => [p.id, p]))
const sealedById = new Map(rawSealed.candidates.map((s) => [s.id, s]))

function sourceArtifactFor(p: PublicMatchPrediction): Omit<PredictionArtifact, "predictionState"> {
  return p.status === "sealed" ? sealedById.get(p.matchId)!.prediction : byId.get(p.matchId)!
}

const all = getAllPublicPredictions()
const sealedPreds = all.filter((p) => p.status === "sealed")
const backtestPreds = all.filter((p) => p.status === "backtest")
const reconstructionPreds = all.filter((p) => p.status === "historical_reconstruction")

// (1) effective catalog maps 380 -------------------------------------------------
test("effective catalog maps all 380 predictions", () => {
  assert.equal(all.length, 380)
  assert.equal(publicPredictionCounts.total, 380)
})

// (2) 40 map to Backtest ---------------------------------------------------------
test("40 predictions map to Backtest", () => {
  assert.equal(backtestPreds.length, 40)
  assert.equal(publicPredictionCounts.backtest, 40)
})

// (3) 10 map to Historical Reconstruction ----------------------------------------
test("10 predictions map to Historical Reconstruction", () => {
  assert.equal(reconstructionPreds.length, 10)
  assert.equal(publicPredictionCounts.historicalReconstruction, 10)
})

// (4) 330 map to Sealed ----------------------------------------------------------
test("330 predictions map to Sealed", () => {
  assert.equal(sealedPreds.length, 330)
  assert.equal(publicPredictionCounts.sealed, 330)
})

// (5) the 330 come from the sealed snapshot, not the raw candidates --------------
test("the 330 sealed predictions are read from the sealed snapshot", () => {
  assert.equal(rawSealed.candidates.length, 330)
  for (const s of rawSealed.candidates) assert.equal(s.predictionState, "sealed")
  for (const p of sealedPreds) {
    assert.ok(p.sealedAt, `${p.matchId} sealed prediction must carry a sealedAt`)
    assert.equal(p.sealedAt, rawManifest.sealedAt)
  }
  // every sealed prediction's core comes from the snapshot, not the unlocked candidate
  for (const p of sealedPreds) {
    const snapshot = sealedById.get(p.matchId)!.prediction
    assert.equal(p.predictedScore.home, snapshot.predictedScoreline.home)
    assert.equal(p.predictedScore.away, snapshot.predictedScoreline.away)
  }
})

// (6) the page does not treat raw Phase VII candidates as official ----------------
test("raw Phase VII candidates stay unlocked; the page only exposes sealed/backtest states", () => {
  const rawCandidates = rawPredictions.filter((p) => p.predictionType === "candidate")
  assert.equal(rawCandidates.length, 340)
  for (const c of rawCandidates) assert.equal(c.predictionState, "unlocked")
  // none of the page-facing predictions are "unlocked" — only the three public states exist
  for (const p of all) assert.ok(["backtest", "historical_reconstruction", "sealed"].includes(p.status))
})

// (7) 50 are permanently ineligible ----------------------------------------------
test("all 50 backtests are permanently ineligible", () => {
  assert.equal(publicPredictionCounts.permanentlyIneligible, 50)
  for (const p of [...backtestPreds, ...reconstructionPreds]) {
    assert.equal(p.eligibleForOfficialAccuracy, false)
    assert.equal(p.publishedAt, null)
  }
})

// (8) 330 are still not officially eligible --------------------------------------
test("the 330 sealed predictions are not yet officially eligible", () => {
  for (const p of sealedPreds) {
    assert.equal(p.eligibleForOfficialAccuracy, false)
    assert.equal(p.publishedAt, null)
  }
})

// (9) publishedAt is null everywhere ---------------------------------------------
test("publishedAt is null for every prediction", () => {
  for (const p of all) assert.equal(p.publishedAt, null)
  assert.equal(publicPredictionCounts.published, 0)
})

// (10) predicted score is correct -------------------------------------------------
test("predicted score matches the source artifact", () => {
  for (const p of all) {
    const src = sourceArtifactFor(p)
    assert.equal(p.predictedScore.home, src.predictedScoreline.home)
    assert.equal(p.predictedScore.away, src.predictedScoreline.away)
  }
})

// (11) predictedResult is correct -------------------------------------------------
test("predictedResult matches the source artifact", () => {
  for (const p of all) {
    assert.equal(p.predictedResult, sourceArtifactFor(p).predictedResult)
  }
})

// (12) H/D/A probabilities unchanged ---------------------------------------------
test("home/draw/away probabilities are unchanged from the artifact", () => {
  for (const p of all) {
    const src = sourceArtifactFor(p)
    assert.equal(p.probabilities.home, src.probabilities.home)
    assert.equal(p.probabilities.draw, src.probabilities.draw)
    assert.equal(p.probabilities.away, src.probabilities.away)
  }
})

// (13) display percentages sum to exactly 100.0% ----------------------------------
test("largest-remainder percentages sum to exactly 100 for all predictions", () => {
  for (const p of all) {
    const [h, d, a] = largestRemainderPercentages(p.probabilities.home, p.probabilities.draw, p.probabilities.away)
    assert.equal(h + d + a, 100)
    assert.ok(h >= 0 && d >= 0 && a >= 0)
    assert.ok(Number.isInteger(h) && Number.isInteger(d) && Number.isInteger(a))
  }
  assert.deepEqual(largestRemainderPercentages(0.5, 0.25, 0.25), [50, 25, 25])
  assert.deepEqual(largestRemainderPercentages(1 / 3, 1 / 3, 1 / 3), [34, 33, 33])
})

// (14) confidence mapping is correct ---------------------------------------------
test("confidence levels map to readable labels and explanations", () => {
  assert.equal(confidenceLabel("low"), "Low Confidence")
  assert.equal(confidenceLabel("medium"), "Medium Confidence")
  assert.equal(confidenceLabel("high"), "High Confidence")
  assert.ok(confidenceExplanation("low").length > 0)
  assert.ok(confidenceExplanation("medium").length > 0)
  assert.ok(confidenceExplanation("high").length > 0)
})

// (15) every prediction carries 3-5 reasons --------------------------------------
test("every prediction has between 3 and 5 reasons", () => {
  for (const p of all) {
    assert.ok(p.reasons.length >= 3 && p.reasons.length <= 5, `${p.matchId} has ${p.reasons.length} reasons`)
  }
})

// (16) DATA_COVERAGE stays neutral -----------------------------------------------
test("DATA_COVERAGE reasons are neutral and not framed as favouring a side", () => {
  const coverage = all.flatMap((p) => p.reasons).filter((r) => r.code === "DATA_COVERAGE")
  assert.ok(coverage.length > 0)
  for (const r of coverage) {
    assert.equal(r.direction, "neutral")
    assert.equal(r.label, "Historical data coverage")
    assert.ok(!/favours|advantage|win/i.test(r.text))
  }
})

// (17) top-3 scorelines are correct ----------------------------------------------
test("top scorelines are the artifact's top-3, in order", () => {
  for (const p of all) {
    const src = sourceArtifactFor(p)
    assert.equal(p.topScorelines.length, 3)
    assert.equal(src.topScorelines.length, 3)
    p.topScorelines.forEach((s, i) => {
      assert.equal(s.home, src.topScorelines[i].home)
      assert.equal(s.away, src.topScorelines[i].away)
      assert.equal(s.probability, src.topScorelines[i].probability)
    })
  }
})

// (18) comparison shown when an actual score exists -------------------------------
test("comparison rows appear when an actual score exists", () => {
  const finishedBacktest = backtestPreds.find((p) => p.actualScore !== null)!
  assert.ok(finishedBacktest, "expected at least one backtest with an actual score")
  const cmp = buildComparison(finishedBacktest)
  assert.equal(cmp.rows.length, 2)
  assert.equal(cmp.rows[0].label, "Score")
  assert.equal(cmp.rows[1].label, "Result")
})

// (19) no guessing when there is no actual score ---------------------------------
test("no score is guessed when the match has no actual score", () => {
  for (const p of [...sealedPreds, ...reconstructionPreds]) {
    assert.equal(p.actualScore, null)
    const cmp = buildComparison(p)
    assert.equal(cmp.rows.length, 0)
    assert.ok(["pending", "not_synced"].includes(cmp.outcome))
    assert.ok(!/\d/.test(cmp.note) || cmp.note === "Result not yet synced") // no fabricated score
  }
})

// (20) backtest disclaimer present ------------------------------------------------
test("backtest state carries the backtest disclaimer", () => {
  const meta = predictionStatusMeta("backtest")
  assert.equal(meta.label, "Backtest")
  assert.ok(meta.extraDisclaimers.some((d) => d.includes("excluded from the official prediction accuracy record")))
})

// (21) late backtest disclaimer present ------------------------------------------
test("historical reconstruction state carries the late-backtest disclaimer", () => {
  const meta = predictionStatusMeta("historical_reconstruction")
  assert.equal(meta.label, "Historical Reconstruction")
  assert.ok(meta.extraDisclaimers.some((d) => d.includes("generated after kickoff")))
})

// (22) sealed state description present ------------------------------------------
test("sealed state explains it was generated and sealed before kickoff", () => {
  const meta = predictionStatusMeta("sealed")
  assert.equal(meta.label, "Sealed AI Prediction")
  assert.ok(meta.description.includes("generated and sealed before kickoff"))
  assert.ok(meta.description.includes("only if published before the match starts"))
})

// (23) universal disclaimer is present on every prediction -----------------------
test("the universal disclaimer is the required wording", () => {
  assert.equal(
    UNIVERSAL_DISCLAIMER,
    "AI predictions are statistical estimates based on historical match data. They do not guarantee future results and should not be treated as betting or financial advice.",
  )
})

// (24) predicted score never enters SportsEvent actual-result fields --------------
test("the SportsEvent schema carries no predicted score", () => {
  const r = resolveStaticMatch(getStaticPremierLeagueMatchParams()[0].slug, "premier-league")
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`)
  const event = footballMatchJsonLd({
    name: "A vs B",
    startDate: r.data.fixture.kickoffAt,
    eventStatus: null,
    url: "https://example.test/x",
    homeTeam: { name: "A" },
    awayTeam: { name: "B" },
  })
  assert.equal("predictedScore" in event, false)
  assert.equal("score" in event, false)
  assert.equal("predictedResult" in event, false)
  assert.equal("result" in event, false)
})

// (25) 380 slugs all statically generated ----------------------------------------
test("all 380 slugs are statically generated", () => {
  const params = getStaticPremierLeagueMatchParams()
  assert.equal(params.length, 380)
})

// (26) no duplicate slugs ---------------------------------------------------------
test("match slugs are unique", () => {
  const params = getStaticPremierLeagueMatchParams()
  assert.equal(new Set(params.map((p) => p.slug)).size, 380)
})

// (27) a hash mismatch fails the build -------------------------------------------
test("hash validation throws on a tampered manifest or prediction", () => {
  const tamperedManifest = { ...rawManifest, sourcePredictionsHash: "0".repeat(64) }
  assert.throws(
    () => validatePredictionSealIntegrity({ manifest: tamperedManifest, predictions: rawPredictions, sealed: rawSealed, catalog: rawCatalog, overrides: rawOverrides }),
    /sourcePredictionsHash/,
  )
  const tamperedPredictions = [...rawPredictions]
  tamperedPredictions[0] = { ...tamperedPredictions[0], predictedResult: ("A" as Result) === tamperedPredictions[0].predictedResult ? "H" : "A" }
  assert.throws(
    () => validatePredictionSealIntegrity({ manifest: rawManifest, predictions: tamperedPredictions, sealed: rawSealed, catalog: rawCatalog, overrides: rawOverrides }),
    /sourcePredictionsHash/,
  )
})

// (28) the page and its data layer never call the network ------------------------
test("prediction page and data layer make no network calls", () => {
  const files = sourceFiles()
  for (const text of files) {
    assert.doesNotMatch(text, /\bfetch\s*\(/, "found a fetch call")
    assert.doesNotMatch(text, /XMLHttpRequest|axios|WebSocket/, "found a network API")
    assert.doesNotMatch(text, /https?:\/\/[^\s"']+football-data\.org/, "found a football-data.org request URL")
  }
})

// (29) the page and its data layer never call Supabase ----------------------------
test("prediction page and data layer make no Supabase calls", () => {
  for (const text of sourceFiles()) {
    assert.doesNotMatch(text, /from\s+["']@supabase|from\s+["']@\/lib\/supabase\/(?!types)/, "found a Supabase import")
    assert.doesNotMatch(text, /getPublicSupabase|getAdminSupabase|createClient/, "found a Supabase client call")
  }
})

// (30) the page never re-runs the prediction model --------------------------------
test("prediction page and data layer never re-run the model", () => {
  for (const text of sourceFiles()) {
    assert.doesNotMatch(text, /predictMatch\s*\(|runBacktest\s*\(|replayMatches\s*\(/, "found a model call")
    assert.doesNotMatch(text, /from\s+["']@\/lib\/model\/predictor|from\s+["']\.\.\/model\/predictor/, "found a predictor import")
    assert.doesNotMatch(text, /from\s+["']@\/lib\/model\/backtest|from\s+["']\.\.\/model\/backtest/, "found a backtest import")
  }
})

/* --------------------------- helpers --------------------------- */

function sourceFiles(): string[] {
  const root = process.cwd()
  return [
    join(root, "app", "premier-league", "matches", "[slug]", "page.tsx"),
    join(root, "lib", "predictions", "public-prediction.ts"),
    join(root, "components", "predictions", "MatchPredictionCard.tsx"),
    join(root, "components", "predictions", "PredictionProbabilityBar.tsx"),
    join(root, "components", "predictions", "PredictionReasons.tsx"),
    join(root, "components", "predictions", "PredictionComparison.tsx"),
    join(root, "components", "predictions", "PredictionDisclosure.tsx"),
  ].map((f) => readFileSync(f, "utf8"))
}

/* --------------------------- extra coverage --------------------------- */

test("transparency rows use full month names and the fixed model label", () => {
  assert.equal(formatTransparencyDate("2026-09-21T15:21:05Z"), "September 21, 2026")
  assert.equal(formatTransparencyDateTime("2026-09-18T00:20:33Z"), "September 18, 2026, 00:20")

  const sealed = sealedPreds[0]
  const rows = transparencyRows(sealed)
  assert.equal(rows[0].label, "Model")
  assert.equal(rows[0].value, "Premier League Prediction Model v1.0.0")
  assert.equal(rows[1].label, "Data through")
  assert.ok(rows[1].value.endsWith("UTC"))
  assert.ok(rows.some((r) => r.label === "Sealed"), "sealed prediction must include a Sealed row")
  assert.ok(rows.some((r) => r.label === "Fixture and result data" && r.value === "football-data.org"))

  const backtest = backtestPreds[0]
  assert.ok(!transparencyRows(backtest).some((r) => r.label === "Sealed"), "backtest must not include a Sealed row")
})

test("resultLabel maps H/D/A to readable words", () => {
  assert.equal(resultLabel("H"), "Home Win")
  assert.equal(resultLabel("D"), "Draw")
  assert.equal(resultLabel("A"), "Away Win")
})

test("buildPublicPredictions is deterministic", () => {
  const a = buildPublicPredictions({ predictions: rawPredictions, sealed: rawSealed, catalog: rawCatalog })
  const b = buildPublicPredictions({ predictions: rawPredictions, sealed: rawSealed, catalog: rawCatalog })
  assert.deepEqual(a.counts, b.counts)
  assert.equal(a.byFixtureId.size, b.byFixtureId.size)
})

test("every Premier League fixture resolves a prediction with matching team slugs", () => {
  const params = getStaticPremierLeagueMatchParams()
  let resolved = 0
  for (const { slug } of params) {
    const r = resolveStaticMatch(slug, "premier-league")
    if (r.kind !== "ok") throw new Error(`expected ok for ${slug}, got ${r.kind}`)
    const p = getPublicMatchPrediction(r.data.fixture)
    assert.equal(p.homeTeam.slug, r.data.fixture.homeTeam.slug)
    assert.equal(p.awayTeam.slug, r.data.fixture.awayTeam.slug)
    resolved++
  }
  assert.equal(resolved, 380)
})
