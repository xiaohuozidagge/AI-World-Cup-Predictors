/**
 * Generate the static 2026/27 Premier League candidate predictions with the v1
 * model ONLY (no v1.1 calibration, no v1.2 draw model).
 *
 *   npm run predictions:pl:generate -- --season 2026-27 \
 *     --generated-at <ISO-UTC> --data-cutoff <ISO-UTC>
 *
 * Behaviour:
 *   - 40 FINISHED fixtures are replayed chronologically (predict-then-update)
 *     as `predictionType: "backtest"` / `predictionState: "historical_reconstruction"`.
 *   - 340 upcoming fixtures are predicted from a single frozen state (history +
 *     40 absorbed results) as `predictionType: "candidate"` /
 *     `predictionState: "unlocked"`.
 *   - No official predictions: `officialPredictionCount: 0`, `officialAccuracy:
 *     null`, `eligibleForOfficialAccuracy: false` on every prediction.
 *
 * Deterministic: every time value comes from the CLI, no `Date.now()` / `new
 * Date()`, no network I/O. Identical inputs produce byte-identical output.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { hashConfig } from "../lib/model/config"
import { predictMatch } from "../lib/model/predictor"
import {
  buildBacktestReport,
  buildManifest,
  buildPredictionArtifact,
  replayMatches,
  sortPredictions,
  type PredictionArtifact,
} from "../lib/model/prediction-artifact"
import { loadModelMatches } from "./model-inputs"
import {
  assert,
  computeGeneratorHash,
  computeInputDataHash,
  currentCommit,
  fail,
  fixtureToMapped,
  loadSnapshot,
  loadV1Config,
  MODEL_VERSION,
  normalizeUtc,
  OUTPUT_DIR,
  SEASON,
  COMPETITION_SLUG,
} from "./prediction-inputs"

interface CliArgs { season: string; generatedAt: string; dataCutoff: string }

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const val = argv[i + 1]
    assert(val !== undefined && !val.startsWith("--"), `missing value for --${key}`)
    args[key] = val
    i++
  }
  assert(args.season, "missing required --season")
  assert(args["generated-at"], "missing required --generated-at")
  assert(args["data-cutoff"], "missing required --data-cutoff")
  return { season: args.season, generatedAt: args["generated-at"], dataCutoff: args["data-cutoff"] }
}

function main(): void {
  const { season, generatedAt, dataCutoff } = parseArgs(process.argv.slice(2))
  assert(season === SEASON, `this script generates only ${SEASON}, got ${season}`)

  const generatedAtUtc = normalizeUtc(generatedAt)
  const dataCutoffUtc = normalizeUtc(dataCutoff)

  const config = loadV1Config()
  const configHash = hashConfig(config)
  const snapshot = loadSnapshot()

  // The cutoff must come from the data, not be invented: require it to equal the
  // source snapshot's last-updated time, and not exceed the generation time.
  const sourceCutoff = normalizeUtc(snapshot.manifest.sourceLastUpdatedAt)
  assert(dataCutoffUtc === sourceCutoff, `--data-cutoff ${dataCutoffUtc} != source last-updated ${sourceCutoff}`)
  assert(dataCutoffUtc <= generatedAtUtc, `--data-cutoff must not be later than --generated-at`)

  // Map the 380 PL fixtures and partition by reliable result fields.
  const mapped = snapshot.fixtures
    .filter((f) => f.competition_id === snapshot.competitionId)
    .map((f) => fixtureToMapped(f, snapshot.teamsById, snapshot.competitionId, generatedAtUtc, dataCutoffUtc, configHash))

  assert(mapped.length === 380, `expected 380 PL fixtures, got ${mapped.length}`)
  const finished = mapped.filter((m) => m.meta.predictionType === "backtest")
  const candidates = mapped.filter((m) => m.meta.predictionType === "candidate")
  assert(finished.length === 40, `expected 40 finished, got ${finished.length}`)
  assert(candidates.length === 340, `expected 340 candidates, got ${candidates.length}`)

  // Uniqueness (defensive; the verify script re-checks against the written file).
  const ids = new Set(mapped.map((m) => m.meta.id))
  const slugs = new Set(mapped.map((m) => m.meta.slug))
  assert(ids.size === 380, "duplicate match ids")
  assert(slugs.size === 380, "duplicate match slugs")

  // Backtest: replay history + 40 finished chronologically (predict-then-update).
  const historyMatches = loadModelMatches()
  const { predictions: backtestPreds, finalState } = replayMatches(
    [...historyMatches, ...finished.map((m) => m.match)],
    config,
    [SEASON],
  )
  assert(backtestPreds.length === 40, `expected 40 backtest predictions, got ${backtestPreds.length}`)

  // Candidates: predict all 340 from the same frozen state (order-independent).
  const candidatePreds = candidates.map((m) => predictMatch(m.match, finalState, config))

  const backtestArtifacts: PredictionArtifact[] = backtestPreds.map((p) => {
    const source = finished.find((m) => m.meta.id === p.matchId)
    assert(source, `backtest prediction ${p.matchId} has no fixture metadata`)
    return buildPredictionArtifact(p, source.meta)
  })
  const candidateArtifacts: PredictionArtifact[] = candidatePreds.map((p) => {
    const source = candidates.find((m) => m.meta.id === p.matchId)
    assert(source, `candidate prediction ${p.matchId} has no fixture metadata`)
    return buildPredictionArtifact(p, source.meta)
  })

  const all = sortPredictions([...backtestArtifacts, ...candidateArtifacts])
  assert(all.length === 380, "total artifacts must be 380")

  const teamSlugs = [...new Set(mapped.flatMap((m) => [m.match.homeSlug, m.match.awaySlug]))].sort()
  assert(teamSlugs.length === 20, `expected 20 teams, got ${teamSlugs.length}`)

  const inputDataHash = computeInputDataHash()
  const generatorHash = computeGeneratorHash()
  const baseCommit = currentCommit()

  const manifest = buildManifest({
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
    modelVersion: MODEL_VERSION,
    configHash,
    generatedAt: generatedAtUtc,
    dataCutoff: dataCutoffUtc,
    baseCommit,
    inputDataHash,
    generatorHash,
    backtestCount: 40,
    candidateCount: 340,
    teams: teamSlugs,
    source: {
      provider: snapshot.manifest.provider,
      sourceLastUpdatedAt: snapshot.manifest.sourceLastUpdatedAt,
      exportedAt: snapshot.manifest.exportedAt,
    },
  })

  const report = buildBacktestReport(backtestPreds, {
    season: SEASON,
    modelVersion: MODEL_VERSION,
    configHash,
    generatedAt: generatedAtUtc,
    dataCutoff: dataCutoffUtc,
  })

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const write = (name: string, obj: unknown) =>
    writeFileSync(join(OUTPUT_DIR, name), JSON.stringify(obj, null, 2) + "\n")
  write("manifest.json", manifest)
  write("predictions.json", all)
  write("backtest-report.json", report)

  const reasonCounts = all.map((p) => p.reasons.length)
  console.log("predictions:pl:generate — done")
  console.log(`  season=${SEASON} model=${MODEL_VERSION} configHash=${configHash.slice(0, 12)}…`)
  console.log(`  generatedAt=${generatedAtUtc} dataCutoff=${dataCutoffUtc} baseCommit=${baseCommit.slice(0, 12)}…`)
  console.log(`  total=380 backtest=40 candidate=340 official=0 eligibleForOfficialAccuracy=false`)
  console.log(`  teams=20 inputDataHash=${inputDataHash.slice(0, 12)}… generatorHash=${generatorHash.slice(0, 12)}…`)
  console.log(`  reasons per match: min=${Math.min(...reasonCounts)} max=${Math.max(...reasonCounts)}`)
}

try {
  main()
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
