/**
 * Read-only verification of the 2026/27 prediction artifacts. Asserts the
 * manifest/predictions/backtest-report are internally consistent, honest, and
 * reproducible, then re-derives every prediction from the frozen v1 config +
 * committed data and byte-compares it against the written files. Exits non-zero
 * on any failure. No network I/O, no clock, no writes.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { hashConfig } from "../lib/model/config"
import { argmaxOneX2 } from "../lib/model/poisson"
import { predictMatch } from "../lib/model/predictor"
import {
  buildBacktestReport,
  buildManifest,
  buildPredictionArtifact,
  replayMatches,
  sortPredictions,
  type BacktestReport,
  type PredictionArtifact,
  type PredictionManifest,
} from "../lib/model/prediction-artifact"
import type { ModelConfig } from "../lib/model/config"
import { loadModelMatches } from "./model-inputs"
import {
  assert,
  computeGeneratorHash,
  COMPETITION_SLUG,
  currentCommit,
  fail,
  fixtureToMapped,
  loadSnapshot,
  loadV1Config,
  MODEL_VERSION,
  normalizeUtc,
  OUTPUT_DIR,
  readJson,
  SEASON,
  V1_CONFIG_HASH,
  type RawCompetition,
  type RawFixture,
  type RawManifest,
  type RawTeam,
  type Snapshot,
} from "./prediction-inputs"
import {
  assertCurrentPlMappingValid,
  assertHistoricalInputHashMatches,
  assertNoChampionsLeagueRuntimeData,
  gitShowBlob,
  readCurrentCompetitions,
  validateProvenanceCommit,
} from "./historical-inputs"

const V1_REASON_CODES = new Set([
  "ELO_ADVANTAGE_HOME",
  "ELO_ADVANTAGE_AWAY",
  "HOME_ATTACK",
  "AWAY_ATTACK",
  "AWAY_DEFENSE_WEAK",
  "HOME_DEFENSE_WEAK",
  "EXPECTED_GOALS",
  "HOME_ADVANTAGE",
  "LIMITED_HISTORY",
])

/** The only artifact-layer reason; sourced from `prediction-artifact`, not v1. */
const DATA_COVERAGE = "DATA_COVERAGE"

interface Derived {
  artifacts: PredictionArtifact[]
  backtestPreds: ReturnType<typeof replayMatches>["predictions"]
}

/** Re-derive the full sorted artifact list + backtest predictions from scratch. */
function derive(
  config: ModelConfig,
  configHash: string,
  snapshot: Snapshot,
  generatedAt: string,
  dataCutoff: string,
): Derived {
  const mapped = snapshot.fixtures
    .filter((f) => f.competition_id === snapshot.competitionId)
    .map((f) => fixtureToMapped(f, snapshot.teamsById, snapshot.competitionId, generatedAt, dataCutoff, configHash))
  const finished = mapped.filter((m) => m.meta.predictionType === "backtest")
  const candidates = mapped.filter((m) => m.meta.predictionType === "candidate")

  const { predictions: backtestPreds, finalState } = replayMatches(
    [...loadModelMatches(), ...finished.map((m) => m.match)],
    config,
    [SEASON],
  )
  const candidatePreds = candidates.map((m) => predictMatch(m.match, finalState, config))

  const artifacts = sortPredictions([
    ...backtestPreds.map((p) => buildPredictionArtifact(p, finished.find((m) => m.meta.id === p.matchId)!.meta)),
    ...candidatePreds.map((p) => buildPredictionArtifact(p, candidates.find((m) => m.meta.id === p.matchId)!.meta)),
  ])
  return { artifacts, backtestPreds }
}

/**
 * Load the generation-time football snapshot from the provenance commit recorded
 * in the prediction manifest. The reproducibility re-derivation and the source
 * cutoff assertions must run against the data the predictions were *actually*
 * generated from — never today's working tree, whose fixtures have since
 * advanced (more matches finished) and whose manifest `sourceLastUpdatedAt` has
 * moved past the frozen `dataCutoff`.
 */
function loadHistoricalSnapshot(commit: string): Snapshot {
  const competitions = JSON.parse(gitShowBlob(commit, "data/football/competitions.json").toString("utf8")) as RawCompetition[]
  const teams = JSON.parse(gitShowBlob(commit, "data/football/teams.json").toString("utf8")) as RawTeam[]
  const fixtures = JSON.parse(gitShowBlob(commit, "data/football/fixtures.json").toString("utf8")) as RawFixture[]
  const manifest = JSON.parse(gitShowBlob(commit, "data/football/manifest.json").toString("utf8")) as RawManifest
  const pl = competitions.find((c) => c.slug === COMPETITION_SLUG)
  assert(pl, "premier-league competition missing from historical snapshot")
  const teamsById = new Map(teams.map((t) => [t.id, t]))
  return { competitionId: pl.id, teamsById, fixtures, manifest }
}

function main(): void {
  for (const name of ["manifest.json", "predictions.json", "backtest-report.json"]) {
    assert(existsSync(join(OUTPUT_DIR, name)), `missing artifact ${name}`)
  }

  const manifest = readJson<PredictionManifest>(join(OUTPUT_DIR, "manifest.json"))
  const predictions = readJson<PredictionArtifact[]>(join(OUTPUT_DIR, "predictions.json"))
  const report = readJson<BacktestReport>(join(OUTPUT_DIR, "backtest-report.json"))

  const config = loadV1Config()
  const configHash = hashConfig(config)
  const snapshot = loadSnapshot()
  const historicalSnapshot = loadHistoricalSnapshot(manifest.baseCommit)

  /* ---- 1. manifest ---- */
  assert(manifest.schemaVersion === 1, "schemaVersion must be 1")
  assert(manifest.competitionSlug === COMPETITION_SLUG, "wrong competition")
  assert(manifest.season === SEASON, "wrong season")
  assert(manifest.modelVersion === MODEL_VERSION, "wrong model version")
  assert(manifest.configHash === configHash && manifest.configHash === V1_CONFIG_HASH, "configHash mismatch")
  assert(manifest.totalPredictions === 380, "totalPredictions must be 380")
  assert(manifest.backtestCount === 40, "backtestCount must be 40")
  assert(manifest.candidateCount === 340, "candidateCount must be 340")
  assert(manifest.officialPredictionCount === 0, "officialPredictionCount must be 0")
  assert(manifest.officialAccuracy === null, "officialAccuracy must be null")
  assert(manifest.eligibleForOfficialAccuracy === false, "eligibleForOfficialAccuracy must be false")
  assert(manifest.teams.length === 20, "manifest must list 20 teams")
  assert(manifest.generatedAt === normalizeUtc(manifest.generatedAt), "generatedAt not normalized UTC")
  assert(manifest.dataCutoff === normalizeUtc(historicalSnapshot.manifest.sourceLastUpdatedAt), "dataCutoff != source cutoff")
  assert(manifest.dataCutoff <= manifest.generatedAt, "dataCutoff must not exceed generatedAt")
  /* ---- A. historical generation integrity ---- */
  validateProvenanceCommit(manifest.baseCommit, currentCommit())
  assertHistoricalInputHashMatches(manifest.baseCommit, manifest.inputDataHash)
  assert(manifest.generatorHash === computeGeneratorHash(), "generatorHash mismatch")
  assert(manifest.source.sourceLastUpdatedAt === historicalSnapshot.manifest.sourceLastUpdatedAt, "source cutoff mismatch")
  assert(manifest.source.exportedAt === historicalSnapshot.manifest.exportedAt, "source exportedAt mismatch")

  /* ---- B. current publication integrity (pruned snapshot, independent of A) ---- */
  assertNoChampionsLeagueRuntimeData(readCurrentCompetitions(), snapshot.fixtures, snapshot.competitionId)
  assertCurrentPlMappingValid(snapshot.fixtures, new Set(snapshot.teamsById.keys()), snapshot.competitionId)

  /* ---- 2. predictions ---- */
  assert(predictions.length === 380, "predictions.json must hold 380 entries")
  const backtest = predictions.filter((p) => p.predictionType === "backtest")
  const candidates = predictions.filter((p) => p.predictionType === "candidate")
  assert(backtest.length === 40, "must be 40 backtest predictions")
  assert(candidates.length === 340, "must be 340 candidate predictions")
  assert(new Set(predictions.map((p) => p.id)).size === 380, "duplicate ids")
  assert(new Set(predictions.map((p) => p.slug)).size === 380, "duplicate slugs")

  const teamSet = new Set(predictions.flatMap((p) => [p.homeTeam.slug, p.awayTeam.slug]))
  assert(teamSet.size === 20, "must span exactly 20 teams")

  let lastKickoff = ""
  for (const p of predictions) {
    assert(p.kickoffUtc >= lastKickoff, "predictions not ordered by kickoffUtc")
    lastKickoff = p.kickoffUtc
    assert(p.competitionSlug === COMPETITION_SLUG, "wrong competition on prediction")
    assert(p.season === SEASON, "wrong season on prediction")
    assert(p.modelVersion === MODEL_VERSION, "wrong model version on prediction")
    assert(p.configHash === configHash, "configHash mismatch on prediction")
    assert(p.eligibleForOfficialAccuracy === false, "prediction must not be eligible for official accuracy")
    assert(p.generatedAt === manifest.generatedAt, "generatedAt drift")
    assert(p.dataCutoff === manifest.dataCutoff, "dataCutoff drift")

    const { home, draw, away } = p.probabilities
    assert(home >= 0 && draw >= 0 && away >= 0, "negative probability")
    assert(Math.abs(home + draw + away - 1) < 1e-9, "probabilities do not sum to 1")
    assert(p.predictedResult === argmaxOneX2(p.probabilities), "predictedResult != argmax")
    assert(Number.isInteger(p.predictedScoreline.home) && Number.isInteger(p.predictedScoreline.away), "non-integer scoreline")

    assert(p.reasons.length >= 3 && p.reasons.length <= 5, "reasons must be 3..5")
    assert(new Set(p.reasons.map((r) => r.code)).size === p.reasons.length, "duplicate reason codes")
    for (const r of p.reasons) {
      assert(V1_REASON_CODES.has(r.code) || r.code === DATA_COVERAGE, `unknown reason code ${r.code}`)
      if (r.code === DATA_COVERAGE) {
        assert(r.source === "prediction-artifact", "DATA_COVERAGE source must be prediction-artifact")
        assert(r.direction === "neutral", "DATA_COVERAGE must be neutral")
        const v = r.value
        assert(typeof v === "object" && Number.isInteger(v.home) && Number.isInteger(v.away), "DATA_COVERAGE value must be {home,away} integer counts")
      } else {
        assert(r.source === "v1", "v1 reason source must be v1")
      }
    }

    if (p.predictionType === "backtest") {
      assert(p.predictionState === "historical_reconstruction", "backtest state wrong")
      assert(p.actualScore !== null && Number.isInteger(p.actualScore.home) && Number.isInteger(p.actualScore.away), "backtest must have a real score")
    } else {
      assert(p.predictionState === "unlocked", "candidate state wrong")
      assert(p.actualScore === null, "candidate must have no final score")
    }
  }

  /* ---- 3. backtest report ---- */
  assert(report.season === SEASON, "report season wrong")
  assert(report.modelVersion === MODEL_VERSION, "report model version wrong")
  assert(report.configHash === configHash, "report configHash mismatch")
  assert(report.matchCount === 40, "report matchCount must be 40")
  assert(report.predictionType === "backtest", "report type wrong")
  assert(report.predictionState === "historical_reconstruction", "report state wrong")
  assert(report.eligibleForOfficialAccuracy === false, "report must not be eligible for official accuracy")
  assert(report.metrics.matchCount === 40, "report metrics matchCount must be 40")

  /* ---- 4. reproducibility: re-derive and byte-compare ---- */
  const derived = derive(config, configHash, historicalSnapshot, manifest.generatedAt, manifest.dataCutoff)
  assert(JSON.stringify(derived.artifacts) === JSON.stringify(predictions), "predictions.json not reproducible")

  const derivedReport = buildBacktestReport(derived.backtestPreds, {
    season: SEASON,
    modelVersion: MODEL_VERSION,
    configHash,
    generatedAt: manifest.generatedAt,
    dataCutoff: manifest.dataCutoff,
  })
  assert(JSON.stringify(derivedReport) === JSON.stringify(report), "backtest-report.json not reproducible")

  const derivedManifest = buildManifest({
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
    modelVersion: MODEL_VERSION,
    configHash,
    generatedAt: manifest.generatedAt,
    dataCutoff: manifest.dataCutoff,
    baseCommit: manifest.baseCommit,
    inputDataHash: manifest.inputDataHash,
    generatorHash: manifest.generatorHash,
    backtestCount: 40,
    candidateCount: 340,
    teams: manifest.teams,
    source: manifest.source,
  })
  assert(JSON.stringify(derivedManifest) === JSON.stringify(manifest), "manifest.json not reproducible")

  console.log("predictions:pl:verify — all checks passed")
  console.log(`  manifest: 380 total (40 backtest + 340 candidate), official=0, eligibleForOfficialAccuracy=false`)
  console.log(`  config: v1 ${MODEL_VERSION}, configHash ${configHash.slice(0, 12)}…, no calibration, no drawModel`)
  console.log(`  data: dataCutoff=${manifest.dataCutoff}, baseCommit=${manifest.baseCommit.slice(0, 12)}…`)
  console.log(`  predictions.json, backtest-report.json, manifest.json all reproducible (byte-identical)`)
}

try {
  main()
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
