/**
 * v1.1 verification. Read-only: asserts the v1.1 artifacts are internally
 * consistent, reproducible, leakage-free, and honest about 2025-26 being an
 * exposed (post-hoc) set rather than an untouched holdout. Exits non-zero on
 * any failure.
 *
 * Checks:
 *   - v1 directory/config is unchanged and its holdout metrics still reproduce,
 *   - v1.1 config is valid, versioned 1.1.0, with the v1 core parameters frozen,
 *   - tuning used only 2022-23 + 2023-24, validation only 2024-25, exposed only 2025-26,
 *   - 2025-26 never entered parameter selection,
 *   - score matrices are normalized, non-negative, draw = diagonal sum,
 *   - no odds fields, no future information, no misleading wording.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  buildScoreMatrix,
  calibrationOf,
  computeDrawMetrics,
  computeMetrics,
  hashConfig,
  resolveConfig,
  runBacktest,
  validateCalibration,
  type DeepPartial,
  type ModelConfig,
} from "../lib/model"
import {
  BURN_IN_SEASON,
  EXPOSED_SEASON_V11,
  filterSeasons,
  HOLDOUT_SEASON,
  inputDataHash,
  loadModelMatches,
  MODEL_DIR,
  MODEL_DIR_V11,
  readJson,
  TUNING_SEASONS_V11,
  VALIDATION_SEASON_V11,
} from "./model-inputs"

const EPS = 1e-9

interface V1HoldoutReport {
  configHash: string
  inputDataHash: string
  matchCount: number
  metrics: MetricSubset
}

interface TuningReportV11 {
  grid: { size: number; valid: number; invalid: number }
  best: { configHash: string }
  seasons: { burnIn: string; tuning: string[] }
}

interface ValidationReportV11 {
  configHash: string
  status: string
  acceptanceCriteria: Record<string, unknown>
  checks: Array<{ name: string; pass: boolean }>
  seasons: { burnIn: string; tuning: string[]; validation: string }
  v1_1: {
    metrics: MetricSubset
    drawMetrics: Record<string, number>
    scorelineQuality?: {
      distinctScorelineCount: number
      totalGoalBias: number
      homeGoalBias: number
      awayGoalBias: number
      oneOneFraction: number
    }
  }
}

interface CalibrationReportV11 {
  bucketCount: number
  buckets: Array<{ predictions: number }>
  drawCalibration: { avgPredictedDrawProbability: number }
}

interface ExposedReportV11 {
  evaluationType: string
  matchCount: number
  note: string
  seasons: { tuning: string[]; validation: string; exposed: string }
  configHashV1_1: string
}

const FIELDS = [
  "accuracy1X2",
  "exactScoreAccuracy",
  "homeGoalsMAE",
  "awayGoalsMAE",
  "totalGoalsMAE",
  "bothWithinOneGoal",
  "brierScore",
  "logLoss",
] as const

type MetricSubset = { [K in (typeof FIELDS)[number]]: number }

const FORBIDDEN_FIELDS = ["odds", "b365", "psh", "psd", "psa", "avgH", "avgD", "avgA", "xg"]
const FORBIDDEN_PHRASES = ["guaranteed", "sure win", "sure bet", "sure-fire"]

function fail(msg: string): never {
  throw new Error(`model:v11:verify FAILED — ${msg}`)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg)
}

function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

function metricsMatch(a: MetricSubset, b: MetricSubset): void {
  for (const f of FIELDS) {
    assert(Number.isFinite(a[f]) && Number.isFinite(b[f]), `metric ${f} not finite`)
    assert(epsEq(a[f], b[f]), `metric ${f} mismatch: ${a[f]} vs ${b[f]}`)
  }
}

function main(): void {
  const allMatches = loadModelMatches()

  /* ---- 1. v1 unchanged & reproducible ---- */
  const v1Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))
  const v1Holdout = readJson<V1HoldoutReport>(join(MODEL_DIR, "holdout-report.json"))
  assert(v1Holdout.configHash === hashConfig(v1Config), "v1 configHash changed (v1 directory modified?)")
  assert(v1Holdout.inputDataHash === inputDataHash(), "input data hash changed")
  const v1Preds = runBacktest(allMatches, v1Config, { evaluateSeasons: [HOLDOUT_SEASON] })
  metricsMatch(computeMetrics(v1Preds), v1Holdout.metrics)

  /* ---- 2. v1.1 config valid + core frozen ---- */
  const v11Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V11, "config.json")))
  assert(v11Config.version === "1.1.0", `v1.1 config version must be 1.1.0, got ${v11Config.version}`)
  validateCalibration(calibrationOf(v11Config))
  assert(JSON.stringify(v11Config.elo) === JSON.stringify(v1Config.elo), "v1.1 changed frozen elo params")
  assert(JSON.stringify(v11Config.strength) === JSON.stringify(v1Config.strength), "v1.1 changed frozen strength params")
  assert(JSON.stringify(v11Config.coverage) === JSON.stringify(v1Config.coverage), "v1.1 changed frozen coverage params")
  assert(JSON.stringify(v11Config.lambda) === JSON.stringify(v1Config.lambda), "v1.1 changed frozen lambda params")
  assert(JSON.stringify(v11Config.confidence) === JSON.stringify(v1Config.confidence), "v1.1 changed frozen confidence params")
  assert(JSON.stringify(v11Config.reasons) === JSON.stringify(v1Config.reasons), "v1.1 changed frozen reasons params")

  const v11Hash = hashConfig(v11Config)

  /* ---- 3. config hash consistency across artifacts ---- */
  const tuning = readJson<TuningReportV11>(join(MODEL_DIR_V11, "tuning-report.json"))
  const validation = readJson<ValidationReportV11>(join(MODEL_DIR_V11, "validation-report.json"))
  assert(tuning.best.configHash === v11Hash, "tuning-report best.configHash mismatch")
  assert(validation.configHash === v11Hash, "validation-report configHash mismatch")

  /* ---- 4. honest season partitioning ---- */
  assert(tuning.seasons.burnIn === BURN_IN_SEASON, "tuning burn-in season wrong")
  assert(JSON.stringify(tuning.seasons.tuning) === JSON.stringify(TUNING_SEASONS_V11), "tuning seasons wrong")
  assert(!tuning.seasons.tuning.includes(VALIDATION_SEASON_V11), "tuning must not include validation season")
  assert(!tuning.seasons.tuning.includes(EXPOSED_SEASON_V11), "tuning must not include 2025-26 (exposed set)")
  assert(validation.seasons.validation === VALIDATION_SEASON_V11, "validation season wrong")
  assert(!validation.seasons.tuning.includes(EXPOSED_SEASON_V11), "validation tuning must not include 2025-26")
  assert(tuning.grid.size === 120, `tuning grid must be 120 cells, got ${tuning.grid.size}`)

  /* ---- 5. validation acceptance criteria + status ---- */
  assert(validation.acceptanceCriteria !== undefined, "validation acceptance criteria missing")
  assert(Array.isArray(validation.checks) && validation.checks.length > 0, "validation checks missing")
  assert(
    validation.status === "accepted_for_exposed_comparison" || validation.status === "rejected",
    `invalid validation status: ${validation.status}`,
  )
  const expectedStatus = validation.checks.every((c) => c.pass) ? "accepted_for_exposed_comparison" : "rejected"
  assert(validation.status === expectedStatus, "validation status inconsistent with checks")

  /* ---- 6. v1.1 reproducibility on validation + matrix properties ---- */
  const validationMatches = filterSeasons(allMatches, [BURN_IN_SEASON, ...TUNING_SEASONS_V11, VALIDATION_SEASON_V11])
  const v11ValPreds = runBacktest(validationMatches, v11Config, { evaluateSeasons: [VALIDATION_SEASON_V11] })
  metricsMatch(computeMetrics(v11ValPreds), validation.v1_1.metrics)
  const v11Draw = computeDrawMetrics(v11ValPreds)
  assert(v11Draw.predictedDrawCount === validation.v1_1.drawMetrics.predictedDrawCount, "draw metrics not reproducible")
  assert(v11Draw.actualDrawCount === validation.v1_1.drawMetrics.actualDrawCount, "draw metrics not reproducible")

  let lastDate = ""
  for (const p of v11ValPreds) {
    assert(p.date >= lastDate, `predictions not chronological at ${p.date}`)
    lastDate = p.date

    const { home, draw, away } = p.probabilities
    assert(home >= 0 && draw >= 0 && away >= 0, `negative probability on ${p.matchId}`)
    assert(Number.isFinite(home + draw + away), `non-finite probabilities on ${p.matchId}`)
    assert(epsEq(home + draw + away, 1), `probabilities do not sum to 1 on ${p.matchId}`)

    // Recompute the score matrix from the stored lambdas and verify the
    // invariants: normalized, non-negative, draw = diagonal sum, and that the
    // stored 1X2 came from the final (corrected) matrix.
    const m = buildScoreMatrix(p.lambdaHome, p.lambdaAway, v11Config)
    let sum = 0
    let diag = 0
    for (let i = 0; i < m.matrix.length; i++) {
      diag += m.matrix[i][i]
      for (let j = 0; j < m.matrix[i].length; j++) {
        const cell = m.matrix[i][j]
        assert(cell >= 0 && Number.isFinite(cell), `bad matrix cell on ${p.matchId}`)
        sum += cell
      }
    }
    assert(epsEq(sum, 1), `score matrix does not sum to 1 on ${p.matchId}`)
    assert(epsEq(m.oneX2.draw, diag), `draw probability != diagonal sum on ${p.matchId}`)
    assert(epsEq(m.oneX2.home, home) && epsEq(m.oneX2.draw, draw) && epsEq(m.oneX2.away, away), `1X2 mismatch on ${p.matchId}`)

    for (const key of Object.keys(p)) {
      assert(!FORBIDDEN_FIELDS.includes(key.toLowerCase()), `leaked field "${key}" on ${p.matchId}`)
    }
  }

  /* ---- 6b. calibration.json (§十三) + scoreline quality (§十四) ---- */
  const calibrationPath = join(MODEL_DIR_V11, "calibration.json")
  assert(existsSync(calibrationPath), "v1.1 calibration.json missing")
  const calibration = readJson<CalibrationReportV11>(calibrationPath)
  assert(calibration.bucketCount === 30, `calibration bucketCount must be 30, got ${calibration.bucketCount}`)
  assert(calibration.buckets.length === 30, `calibration buckets must be 30, got ${calibration.buckets.length}`)
  const calTotal = calibration.buckets.reduce((s, b) => s + b.predictions, 0)
  assert(calTotal === v11ValPreds.length * 3, `calibration sample total must be 3×matches (${v11ValPreds.length * 3}), got ${calTotal}`)
  assert(
    Number.isFinite(calibration.drawCalibration.avgPredictedDrawProbability),
    "draw calibration missing avg predicted draw probability",
  )

  const v11Scoreline = validation.v1_1.scorelineQuality
  assert(v11Scoreline !== undefined, "validation report missing scorelineQuality")
  assert(Number.isInteger(v11Scoreline.distinctScorelineCount) && v11Scoreline.distinctScorelineCount > 0, "distinct scoreline count invalid")
  assert(Number.isFinite(v11Scoreline.totalGoalBias), "total goal bias missing")
  assert(Number.isFinite(v11Scoreline.homeGoalBias) && Number.isFinite(v11Scoreline.awayGoalBias), "home/away goal bias missing")
  assert(Number.isFinite(v11Scoreline.oneOneFraction), "1-1 fraction missing")

  /* ---- 7. exposed comparison (optional until it has run) ---- */
  const exposedPath = join(MODEL_DIR_V11, "exposed-comparison-report.json")
  if (existsSync(exposedPath)) {
    const exposed = readJson<ExposedReportV11>(exposedPath)
    assert(exposed.evaluationType === "exposed_post_hoc_comparison", "exposed report must be post-hoc comparison")
    assert(exposed.matchCount === 380, `exposed matchCount must be 380, got ${exposed.matchCount}`)
    assert(exposed.seasons.exposed === EXPOSED_SEASON_V11, "exposed season wrong")
    assert(exposed.configHashV1_1 === v11Hash, "exposed report configHash mismatch")
    assert(
      exposed.note.toLowerCase().includes("not an untouched holdout") && exposed.note.toLowerCase().includes("post-hoc"),
      "exposed report must state it is NOT an untouched holdout",
    )
  }

  /* ---- 8. no misleading wording in any report ---- */
  for (const name of ["tuning-report.json", "validation-report.json", "exposed-comparison-report.json"]) {
    const path = join(MODEL_DIR_V11, name)
    if (!existsSync(path)) continue
    const text = readFileSync(path, "utf-8").toLowerCase()
    for (const phrase of FORBIDDEN_PHRASES) {
      assert(!text.includes(phrase), `report ${name} contains misleading phrase "${phrase}"`)
    }
  }

  console.log("model:v11:verify — all checks passed")
  console.log(`  v1 unchanged & reproducible (configHash ${v1Holdout.configHash.slice(0, 12)}…)`)
  console.log(`  v1.1 config valid, core frozen, configHash ${v11Hash.slice(0, 12)}…`)
  console.log(`  tuning=${TUNING_SEASONS_V11.join("+")} validation=${VALIDATION_SEASON_V11} exposed=${EXPOSED_SEASON_V11}`)
  console.log(`  validation status: ${validation.status}`)
  console.log(`  score matrices normalized, draw = diagonal sum, no leakage`)
}

main()
